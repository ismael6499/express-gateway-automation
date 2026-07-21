$cpu = (Get-CimInstance Win32_Processor).LoadPercentage
if ($cpu -eq $null) { $cpu = 0 }
$mem = Get-CimInstance Win32_OperatingSystem
$totalRam = [Math]::Round($mem.TotalVisibleMemorySize / 1024 / 1024, 1)
$freeRam = [Math]::Round($mem.FreePhysicalMemory / 1024 / 1024, 1)
$usedRam = [Math]::Round($totalRam - $freeRam, 1)
$ramPct = [Math]::Round(($usedRam / $totalRam) * 100, 1)
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
$batPct = if ($bat) { $bat.EstimatedChargeRemaining } else { $null }
$temp = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue
$tempVal = if ($temp) {
    $t = ($temp | Select-Object -First 1).CurrentTemperature
    [Math]::Round(($t / 10) - 273.15, 1)
} else { $null }
@{cpu=$cpu; ramTotal=$totalRam; ramUsed=$usedRam; ramPct=$ramPct; battery=$batPct; temp=$tempVal} | ConvertTo-Json -Compress
