Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Screen {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int n);
}
'@
[Screen]::SetProcessDPIAware() | Out-Null
[Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null
$w = [Screen]::GetSystemMetrics(0)
$h = [Screen]::GetSystemMetrics(1)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
