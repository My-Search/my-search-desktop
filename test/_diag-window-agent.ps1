<#
  Window agent v3: track the app's main window, report visibility/rect changes,
  and capture the window content with PrintWindow(PW_RENDERFULLCONTENT)
  (works for WebView2 / DirectComposition windows, unlike CopyFromScreen).

  stdout (epoch ms):
    READY <ms>
    PICK  <ms> <pid> <hwnd> <title>
    STATE <ms> <hwnd> <visible|hidden|absent> <x> <y> <w> <h>
    SHOT  <ms> <file>
#>
param(
  [string]$ProcName = "my-search-desktop",
  [string]$TitleB64 = "",
  [string]$OutDir = $env:TEMP,
  [int]$IntervalMs = 120,
  [int]$Shots = 40
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class MsWin3 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static List<IntPtr> TopLevel(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p = 0;
      GetWindowThreadProcessId(h, out p);
      if (p == pid) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string TitleOf(IntPtr h) {
    int len = GetWindowTextLengthW(h);
    if (len <= 0) return "";
    var sb = new StringBuilder(len + 2);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static bool Vis(IntPtr h) { return IsWindowVisible(h); }
  public static bool Alive(IntPtr h) { return IsWindow(h); }
  public static int[] Rect(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return new int[] {0,0,0,0};
    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
  }
}
"@

# 截图在 PowerShell 侧完成（C# 里引用 System.Drawing 需要 -ReferencedAssemblies，
# 交给 PS 更省事）
function Save-WindowShot([IntPtr]$h, [int]$w, [int]$hh, [string]$path) {
  try {
    $bmp = New-Object System.Drawing.Bitmap($w, $hh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [MsWin3]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return $ok
  } catch {
    return $false
  }
}

function Get-NowMs { [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$Title = ""
if ($TitleB64.Length -gt 0) { $Title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TitleB64)) }
Write-Output ("READY {0}" -f (Get-NowMs))

$proc = $null
for ($i = 0; $i -lt 20000 -and $null -eq $proc; $i++) {
  $proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $proc) { Start-Sleep -Milliseconds 5 }
}
if ($null -eq $proc) { Write-Output ("NOAPP {0}" -f (Get-NowMs)); exit 1 }
$targetPid = [uint32]$proc.Id

$pick = [IntPtr]::Zero
for ($round = 0; $round -lt 20000; $round++) {
  $best = [IntPtr]::Zero
  $bestW = -1
  foreach ($h in [MsWin3]::TopLevel($targetPid)) {
    $t = [MsWin3]::TitleOf($h)
    if ($Title.Length -gt 0) {
      if ($t -eq $Title) { $best = $h; break }
      continue
    }
    $r = [MsWin3]::Rect($h)
    if ($t.Length -eq 0 -and $r[2] -lt 200) { continue }
    if ($r[2] -gt $bestW) { $bestW = $r[2]; $best = $h }
  }
  if ($best -ne [IntPtr]::Zero) { $pick = $best; break }
  Start-Sleep -Milliseconds 5
}
Write-Output ("PICK {0} {1} {2} {3}" -f (Get-NowMs), $targetPid, $pick, ([MsWin3]::TitleOf($pick)))

$lastKey = ''
$shotCount = 0
$shotAtNext = 0

while ($true) {
  if (-not [MsWin3]::Alive($pick)) { Write-Output ("STATE {0} {1} absent 0 0 0 0" -f (Get-NowMs), $pick); break }
  $vis = [MsWin3]::Vis($pick)
  $rect = [MsWin3]::Rect($pick)
  $state = if ($vis) { 'visible' } else { 'hidden' }
  $key = "$state/$($rect -join ',')"
  if ($key -ne $lastKey) {
    Write-Output ("STATE {0} {1} {2} {3}" -f (Get-NowMs), $pick, $state, ($rect -join ' '))
    $lastKey = $key
    if ($state -eq 'visible') { $shotCount = 0; $shotAtNext = 0 }
  }
  if ($state -eq 'visible' -and $shotCount -lt $Shots) {
    $nowMs = Get-NowMs
    if ($nowMs -ge $shotAtNext) {
      $w = $rect[2]; $h = $rect[3]
      if ($w -gt 0 -and $h -gt 0) {
        $file = Join-Path $OutDir ("win-{0:D4}-{1}.png" -f $shotCount, $nowMs)
        Save-WindowShot $pick $w $h $file | Out-Null
        Write-Output ("SHOT  {0} {1}" -f $nowMs, $file)
        $shotCount++
      }
      $shotAtNext = $nowMs + $IntervalMs
    }
    Start-Sleep -Milliseconds 10
    continue
  }
  Start-Sleep -Milliseconds 5
}
