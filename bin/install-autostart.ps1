# Register logon + 1-minute watchdog autostart for wb-deepseek-proxy.
# start.ps1 is idempotent: it returns immediately when the port is already listening,
# so the repeating trigger only ever restarts a dead proxy.
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$start = Join-Path $here 'bin\start.ps1'
$name = 'WbDeepseekProxy'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""

$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $watchdog) -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
"registered task '$name' (logon + every 1 min) -> $start"
