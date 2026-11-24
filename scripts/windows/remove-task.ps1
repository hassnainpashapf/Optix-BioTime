$name = 'OKT Attendance Server'
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
# the launcher keeps a child node process: stop whatever runs from the install folder
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -like '*\OKT\node.exe' -or $_.ExecutablePath -like '*\ZKT\node.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
