# Persistent region frame for the recorder plugin.
#
# Draws a click-through, topmost, taskbar-hidden ring OUTSIDE the rectangle
# being recorded, so the user can see the capture area for the whole session
# while the ring itself is never part of the video (same trick gdigrab uses
# for -show_region: the ring lives in the band [x-t, x) which the capture crop
# never covers).
#
# Why this exists instead of gdigrab's -show_region:
#   * -show_region hangs on ffmpeg 6.x/7.x (ffmpeg trac #11539, fixed in 8.0),
#     and the plugin may be pointed at a user-supplied build;
#   * Windows capture now prefers ddagrab (see backend/index.mjs), which has
#     no show_region option at all;
#   * a host-side window would need app rebuild + new capability; this keeps
#     the whole feature inside the hot-reloadable plugin.
#
# Keep this file ASCII-only: powershell.exe reads .ps1 files as ANSI when
# there is no BOM, so non-ASCII bytes in comments/strings get mangled
# (same rule as plugins/screenshot/backend/capture.ps1).
#
# Usage:
#   powershell.exe -NoProfile -File region-border.ps1 -X 100 -Y 100 -Width 640 -Height 360 `
#       [-Thickness 3] [-Color "#FF3B30"] [-ParentPid 1234]
#
# Prints one line `rect=<x>,<y>,<w>,<h>` (outer window bounds, physical px)
# right before showing, then blocks until killed or -ParentPid exits.
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height,
  # Ring thickness in physical pixels. Kept inside the band outside the
  # recorded rectangle, so it can never appear in the video.
  [int]$Thickness = 3,
  # Ring colour (#RRGGBB).
  [string]$Color = "#FF3B30",
  # Recorder backend pid; the frame exits when it disappears (crash safety).
  [int]$ParentPid = 0
)

$ErrorActionPreference = "Stop"

# Coordinates must be PHYSICAL pixels: ffmpeg's gdigrab/ddagrab both work in
# physical desktop space, while an un-aware PowerShell reports logical px
# (e.g. 1707x960 instead of 2560x1440 on a 150% display). Upgrade the process
# to per-monitor awareness BEFORE WinForms is even loaded: if the assemblies
# are loaded while the process is still un-aware, WinForms caches that state
# and window creation intermittently hangs in a DPI-change loop (verified:
# Show() never returns, no window ever paints).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class BorderDpi {
    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
'@

$aware = $false
try { $aware = [BorderDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { $aware = $false }
if (-not $aware) {
  # Fall back to system awareness (still physical on a single-DPI machine).
  try { [void][BorderDpi]::SetProcessDPIAware() } catch { }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# A shaped window: only the 3px band exists, the interior is not a window at
# all, so the desktop shows through and the capture area stays untouched.
# Add-Type compiles against mscorlib only: the WinForms/Drawing references
# have to be listed explicitly.
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;

public class RegionBorderForm : Form {
    public int Ring = 3;

    public RegionBorderForm() {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        MinimizeBox = false;
        MaximizeBox = false;
        Text = "my-search-recorder-region";
        // ResizeRedraw only: do NOT set ControlStyles.Opaque -- Opaque tells
        // WinForms "I paint everything myself in OnPaint", which would skip
        // the BackColor erase and leave the ring invisible.
        SetStyle(ControlStyles.ResizeRedraw, true);
    }

    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            // WS_EX_TOOLWINDOW  = keep out of taskbar and Alt+Tab
            // WS_EX_NOACTIVATE  = never steal focus from the user's apps
            // WS_EX_TRANSPARENT = clicks fall through to whatever is below
            const int WS_EX_TOOLWINDOW = 0x00000080;
            const int WS_EX_NOACTIVATE = 0x08000000;
            const int WS_EX_TRANSPARENT = 0x00000020;
            cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT;
            return cp;
        }
    }

    private void ApplyRingRegion() {
        int w = ClientSize.Width;
        int h = ClientSize.Height;
        int t = Math.Max(1, Ring);
        if (w <= 2 * t || h <= 2 * t) { Region = null; return; }
        Region outer = new Region(new Rectangle(0, 0, w, h));
        outer.Exclude(new Rectangle(t, t, w - 2 * t, h - 2 * t));
        // Do NOT Dispose() the region here: Control.Region takes it over and
        // SetWindowRgn transfers the HRGN ownership to the OS. Disposing it
        // while the window still uses it hangs the very next GDI call
        // (verified on this machine: Show() never returns).
        Region = outer;
    }

    protected override void OnLoad(EventArgs e) {
        base.OnLoad(e);
        ApplyRingRegion();
    }

    protected override void OnResize(EventArgs e) {
        base.OnResize(e);
        if (ClientSize.Width > 0 && ClientSize.Height > 0) ApplyRingRegion();
    }
}
'@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

$colorObj = [System.Drawing.ColorTranslator]::FromHtml($Color)

# Outer window = recorded rect grown by the thickness on every side, so the
# ring occupies exactly [x-t, x) x [y, y+h) etc. -- outside the capture crop.
$outerX = $X - $Thickness
$outerY = $Y - $Thickness
$outerW = $Width + (2 * $Thickness)
$outerH = $Height + (2 * $Thickness)

$form = New-Object RegionBorderForm
$form.Ring = $Thickness
$form.BackColor = $colorObj
$form.Bounds = New-Object System.Drawing.Rectangle $outerX, $outerY, $outerW, $outerH

Write-Output ("rect={0},{1},{2},{3}" -f $outerX, $outerY, $outerW, $outerH)
[Console]::Out.Flush()
# Crash safety: if the recorder backend dies without killing us, exit here.
# ($ParentPid is a script-scope variable, visible to the timer handler.)
if ($ParentPid -gt 0) {
  $watchTimer = New-Object System.Windows.Forms.Timer
  $watchTimer.Interval = 2000
  $watchTimer.Add_Tick({
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
      $form.Close()
    }
  })
  $watchTimer.Start()
}

[System.Windows.Forms.Application]::Run($form)
