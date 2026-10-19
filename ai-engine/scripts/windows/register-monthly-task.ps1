# Registers the GrW-MBM-monthly scheduled task (MBM M4): 1st Saturday of every month, 11:00,
# one hour after the Saturday GrW-MBM-build task. It runs `mbm_monthly.py run` only — promotion is a
# human command and is never scheduled. Re-running this script replaces the task (/F).
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\AryanKumar\Desktop\GrW\ai-engine\scripts\windows\register-monthly-task.ps1
$ErrorActionPreference = 'Stop'
$meta = 'C:\Users\AryanKumar\grw-mbm\_meta'
$wrapper = Join-Path $meta 'monthly-run.cmd'
Copy-Item -Force (Join-Path $PSScriptRoot 'monthly-run.cmd') $wrapper
schtasks /Create /F /SC MONTHLY /MO FIRST /D SAT /ST 11:00 /TN GrW-MBM-monthly /TR "`"$wrapper`""
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed ($LASTEXITCODE)" }
schtasks /Query /TN GrW-MBM-monthly
