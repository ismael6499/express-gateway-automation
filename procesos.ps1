Get-Process | Sort-Object WS -Descending | Select-Object -First 5 | ForEach-Object {
    [PSCustomObject]@{
        pid = $_.Id
        name = $_.ProcessName
        ram = [Math]::Round($_.WS / 1024 / 1024, 1)
    }
} | ConvertTo-Json -Compress
