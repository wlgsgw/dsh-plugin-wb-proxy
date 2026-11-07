# Remove the logon autostart task.
Unregister-ScheduledTask -TaskName 'WbDeepseekProxy' -Confirm:$false -ErrorAction SilentlyContinue
"removed task 'WbDeepseekProxy' (if it existed)"
