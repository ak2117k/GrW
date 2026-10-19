@echo off
rem GrW-MBM-monthly wrapper (MBM M4 self-learning loop): `mbm_monthly.py run` ONLY, never promote.
rem Copied to C:\Users\AryanKumar\grw-mbm\_meta\monthly-run.cmd by register-monthly-task.ps1.
rem Uses Git's ssh/scp (Windows OpenSSH rejects the key's ACL) and keeps a log, like weekly-build.cmd.
set "PATH=C:\Users\AryanKumar\AppData\Local\Programs\Git\usr\bin;%PATH%"
set PYTHONIOENCODING=utf-8
"C:\Users\AryanKumar\AppData\Local\Python\pythoncore-3.14-64\python.exe" "C:\Users\AryanKumar\Desktop\GrW\ai-engine\scripts\mbm_monthly.py" run --vps root@157.10.98.70 --ssh-key "C:\Users\AryanKumar\.ssh\grw_oracle" > "C:\Users\AryanKumar\grw-mbm\_meta\monthly-run.log" 2>&1
exit /b %ERRORLEVEL%
