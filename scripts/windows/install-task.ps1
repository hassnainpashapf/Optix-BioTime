# Registers the Optix server as a scheduled task that starts with Windows (as SYSTEM), restarts itself and never times out.
param([Parameter(Mandatory=$true)][string]$InstallDir)
$ErrorActionPreference = 'Stop'
$name = 'OKT Attendance Server'
$node = Join-Path $InstallDir 'node.exe'
$launcher = Join-Path $InstallDir 'app\launcher.js'
$a = New-ScheduledTaskAction -Execute $node -Argument ('"' + $launcher + '"') -WorkingDirectory (Join-Path $InstallDir 'app')
$t = New-ScheduledTaskTrigger -AtStartup
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $a -Trigger $t -Settings $s -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 1
if ((Get-ScheduledTask -TaskName $name).State -ne 'Running') {
  throw 'The ZKT Attendance Server scheduled task did not start.'
}
