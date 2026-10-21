<#
.SYNOPSIS
  Registers (or replaces) the Windows scheduled task "GrW-Research-Backup": nightly at 23:30 local
  time (IST), before the VPS's grw-backup at 00:15 IST, so each night's R2 copy carries that
  day's research. Runs as the current user, only while logged on (no stored password); a run
  missed while the PC was off or asleep starts as soon as it is available.

  Unregister with:  Unregister-ScheduledTask -TaskName GrW-Research-Backup -Confirm:$false
#>
param(
  [string]$Script = (Join-Path $PSScriptRoot 'backup-research.ps1'),
  [string]$At = '23:30',
  [string]$TaskName = 'GrW-Research-Backup'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Script)) { throw "not found: $Script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $Script)
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'GrW: copy changed grw-mbm research files to the VPS (scripts/research-backup)' -Force |
  Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
