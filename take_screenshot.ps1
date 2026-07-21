Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$artifactPath = "C:\Users\agust\.gemini\antigravity-ide\brain\34b87053-a772-4fba-bbb4-5e2f5db1d181\desktop_screenshot.png"
console-log "Capturando pantalla..."

try {
    $Screen = [System.Windows.Forms.Screen]::PrimaryScreen
    $Bounds = $Screen.Bounds
    $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
    $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
    $Graphics.CopyFromScreen($Bounds.Location, [System.Drawing.Point]::Empty, $Bounds.Size)
    $Bitmap.Save($artifactPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $Graphics.Dispose()
    $Bitmap.Dispose()
    Write-Output "Captura de pantalla guardada con éxito en $artifactPath"
} catch {
    Write-Error "Error al capturar pantalla: $_"
}
