# Frozen full-virtual-desktop snapshot for the recorder's region picker.
#
# Captures the whole virtual desktop (all monitors) to a PNG and prints the
# physical bounds of that capture, so the plugin UI can (a) show the desktop
# as a canvas the user drags a rectangle on, and (b) map that rectangle back
# to real screen coordinates that gdigrab/ddagrab understand.
#
# Why PowerShell and not ffmpeg: the picker must work before the user has
# downloaded any ffmpeg, and the bounds/origin come from the same process that
# takes the pixels, so there is no coordinate-space mismatch.
#
# Keep this file ASCII-only: powershell.exe reads .ps1 as ANSI when there is no
# BOM, so non-ASCII bytes in comments/strings get mangled (same rule as
# plugins/screenshot/backend/capture.ps1).
#
# Usage:
#   powershell.exe -NoProfile -File screen-snapshot.ps1 -Out C:\path\snap.png
#
# Output (stdout, one line):
#   bounds=<x>,<y>,<w>,<h>        physical virtual-desktop rect of the capture
#   dpi=pmv2|system|none          which awareness level we managed to set
param(
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"

# Upgrade to per-monitor DPI awareness BEFORE WinForms/Drawing is loaded:
# only then do GetSystemMetrics and CopyFromScreen speak physical pixels
# (on a 150% display an un-aware process would report 1707x960 instead of
# 2560x1440, and every picked region would land in the wrong place).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SnapDpi {
    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
}
'@

$level = "none"
try {
  if ([SnapDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $level = "pmv2" }
} catch { }
if ($level -eq "none") {
  try {
    if ([SnapDpi]::SetProcessDPIAware()) { $level = "system" }
  } catch { }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77, SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79
$x = [SnapDpi]::GetSystemMetrics(76)
$y = [SnapDpi]::GetSystemMetrics(77)
$w = [SnapDpi]::GetSystemMetrics(78)
$h = [SnapDpi]::GetSystemMetrics(79)
if ($w -le 0 -or $h -le 0) {
  [Console]::Error.WriteLine("invalid virtual screen size: ${w}x${h}")
  exit 1
}
# Guard against absurd multi-monitor walls: the PNG travels over JSON-RPC.
if ($w -gt 12000 -or $h -gt 12000) {
  [Console]::Error.WriteLine("virtual screen too large: ${w}x${h}")
  exit 1
}

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)

  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }

  # Downscale large desktops: the picker only displays ~1600px wide, and the
  # base64 PNG crosses the plugin's JSON-RPC pipe. Mapping back to screen
  # coordinates stays exact because `bounds` below is the physical rect and
  # the UI scales by image.naturalWidth / bounds.width.
  $maxW = 1600
  if ($w -gt $maxW) {
    $nh = [int][math]::Round($h * $maxW / $w)
    if ($nh -lt 1) { $nh = 1 }
    $scaled = New-Object System.Drawing.Bitmap $maxW, $nh
    $g2 = [System.Drawing.Graphics]::FromImage($scaled)
    try {
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($bmp, 0, 0, $maxW, $nh)
      $scaled.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $g2.Dispose()
      $scaled.Dispose()
    }
  } else {
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  }
} finally {
  $g.Dispose()
  $bmp.Dispose()
}

if (-not (Test-Path $Out)) {
  [Console]::Error.WriteLine("capture produced no file")
  exit 1
}

Write-Output ("dpi=" + $level)
Write-Output ("bounds={0},{1},{2},{3}" -f $x, $y, $w, $h)
