# Resource monitor plugin - raw sampler (Windows).
#
# NOTE: keep this file ASCII-only (no BOM). PowerShell on Chinese Windows reads
# a .ps1 without BOM as ANSI/GBK, so non-ASCII comments can corrupt parsing.
#
# What it does: a long-running loop that, every IntervalMs, prints ONE compact
# JSON line to stdout describing a raw snapshot of the machine:
#
#   {"t":<ms>,"cores":<n>,"mem":{"totalKB":<n>,"freeKB":<n>},
#    "net":{"sentTotal":<bytes>,"recvTotal":<bytes>},"procs":[ ... ]}
#
#   procs[i] = {"pid":<n>,"name":"...","k":<100ns>,"u":<100ns>,
#               "ws":<bytes>,"other":<bytes>,"path":"<exe>"}
#
# It deliberately does NOT compute rates - differencing/aggregation/ranking is
# done in Node (backend/aggregate.mjs) so the maths is unit-testable.
#
# Fields:
#   k/u   = KernelModeTime / UserModeTime (cumulative CPU, 100ns units)
#   ws    = WorkingSetSize (bytes)
#   other = OtherTransferCount (bytes of "other" IO object granularity; the
#           only per-process network-ish counter obtainable without admin)
#   path  = ExecutablePath ("" for protected / elevated processes). Carried so
#           the UI can reveal a program's file instantly, without a fresh and
#           slow process enumeration at click time.
#
# net.sentTotal / net.recvTotal = sum of all adapters' cumulative SentBytes /
# ReceivedBytes, giving a TRUE (system-wide, not per-process) upload/download
# rate once Node differences two snapshots.
#
# Output goes to stdout only; errors to stderr. The caller parses stdout.

param(
  [int]$IntervalMs = 5000,
  [int]$MaxIterations = 0,   # 0 = run forever (host usage); >0 = stop after N (tests)
  [int]$WarmupMs = 0
)

$ErrorActionPreference = "SilentlyContinue"

# Emit UTF-8 so the Node reader's lossy UTF-8 decode is exact (process names
# can contain non-ASCII characters).
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# Reduce per-call overhead; CIM queries are the bulk of the work.
$cimOptions = New-Object Microsoft.Management.Infrastructure.Options.CimOperationOptions
$cimOptions.SetCustomOption("operationTimeout", [uint32]5000, $false) | Out-Null

function Write-Line([string]$text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

function Get-Snapshot {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  # --- logical processors ---
  $cores = [int]$env:NUMBER_OF_PROCESSORS
  if ($cores -lt 1) { $cores = 1 }

  # --- memory (KB) ---
  $totalKB = 0; $freeKB = 0
  foreach ($os in (Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory)) {
    $totalKB = [long]$os.TotalVisibleMemorySize
    $freeKB  = [long]$os.FreePhysicalMemory
    break
  }

  # --- per-process counters ---
  $procs = New-Object System.Collections.Generic.List[object]
  foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath,KernelModeTime,UserModeTime,WorkingSetSize,OtherTransferCount)) {
    $procs.Add([pscustomobject]@{
      pid   = [int]$p.ProcessId
      name  = [string]$p.Name
      k     = [long]$p.KernelModeTime
      u     = [long]$p.UserModeTime
      ws    = [long]$p.WorkingSetSize
      other = [long]$p.OtherTransferCount
      path  = [string]$p.ExecutablePath
    })
  }

  # --- network totals (cumulative bytes across all adapters) ---
  $sentTotal = 0; $recvTotal = 0
  foreach ($a in (Get-NetAdapterStatistics)) {
    $sentTotal += [long]$a.SentBytes
    $recvTotal += [long]$a.ReceivedBytes
  }

  return [pscustomobject]@{
    t     = $now
    cores = $cores
    mem   = [pscustomobject]@{ totalKB = $totalKB; freeKB = $freeKB }
    net   = [pscustomobject]@{ sentTotal = $sentTotal; recvTotal = $recvTotal }
    procs = $procs
  }
}

if ($WarmupMs -gt 0) { Start-Sleep -Milliseconds $WarmupMs }

$iteration = 0
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $sw.Restart()
  try {
    $snap = Get-Snapshot
    $json = ConvertTo-Json -InputObject $snap -Depth 4 -Compress
    Write-Line $json
  } catch {
    # Never die on a single bad sample; report it so Node can skip this tick.
    $err = [pscustomobject]@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); err = [string]$_.Exception.Message }
    Write-Line (ConvertTo-Json -InputObject $err -Depth 2 -Compress)
    [Console]::Error.WriteLine("[sample.ps1] " + $_.Exception.Message)
  }

  $iteration++
  if ($MaxIterations -gt 0 -and $iteration -ge $MaxIterations) { break }

  $remain = $IntervalMs - $sw.ElapsedMilliseconds
  if ($remain -gt 0) { Start-Sleep -Milliseconds $remain }
}

# Node kills us on shutdown; exit cleanly if it closes the pipe first.
exit 0
