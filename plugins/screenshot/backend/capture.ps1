# Screenshot fallback capture for the my-search screenshot plugin backend.
#
# Captures the WHOLE virtual desktop (all monitors) to a PNG file.
# Used only as a fallback when the host's own screenshot_capture command
# is unavailable; the normal path is implemented natively in Rust.
#
# Keep this file ASCII-only: it is invoked by powershell.exe from run.cmd and
# is read as ANSI on some systems, where non-ASCII characters get mangled.
#
# Usage:
#   powershell.exe -NoProfile -File capture.ps1 -Out C:\path\shot.png

param(
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Virtual screen bounds (covers every monitor, origin may be negative)
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  Write-Error "invalid virtual screen size: $($bounds.Width)x$($bounds.Height)"
  exit 1
}

$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

try {
  $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)

  # Make sure the target directory exists
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }

  $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

if (-not (Test-Path $Out)) {
  Write-Error "capture produced no file"
  exit 1
}

Write-Output "captured $($bounds.Width)x$($bounds.Height) -> $Out"
