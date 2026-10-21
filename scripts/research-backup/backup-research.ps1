<#
.SYNOPSIS
  Nightly off-PC backup of the MBM / ML research store (C:\Users\AryanKumar\grw-mbm) to the VPS.

.DESCRIPTION
  Copies only files that are NEW or CHANGED since the last successful run (size + mtime, kept in
  _meta\research-backup.state.json) to root@VPS:/opt/grw/research-backup/, as one tar.gz per run
  that is unpacked in place on the VPS. Files deleted on the PC are kept on the VPS (it is a backup).
  The VPS's nightly grw-backup (scripts/ops/backup.sh) then copies that folder to R2 when
  RESEARCH_BACKUP_DIR is set in /opt/grw/env/ops.env.

  Git for Windows has no rsync, so this is tar + scp. ssh/scp come from Git's usr\bin, because
  Windows OpenSSH rejects the key's ACL (same as _meta\weekly-build.cmd). tar is Windows' own
  bsdtar (C:\Windows\System32\tar.exe), which takes Windows paths natively.

  EXCLUDED by default: caches that can be rebuilt or re-downloaded, which would not fit the VPS
  disk (20 GB, ~71% used):
    bars\                     Angel 1m/1d/60m bars, re-downloadable via ai-engine/scripts/mbm_data.py build
    research\*\data\          chart-image rendered .npy arrays (re-render from bars) and
                              stock-daily fetched data (re-fetch with its fetch*.py)
    __pycache__\, *.pyc       bytecode
  Pass -IncludeBars to also back up bars\ (~255 MB).

.PARAMETER DryRun
  Build the archive and print what would be sent; upload nothing and keep the state unchanged.
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\Users\AryanKumar\grw-mbm',
  [string]$Vps = 'root@157.10.98.70',
  [string]$SshKey = 'C:\Users\AryanKumar\.ssh\grw_oracle',
  [string]$RemoteDir = '/opt/grw/research-backup',
  [string]$GitUsrBin = 'C:\Users\AryanKumar\AppData\Local\Programs\Git\usr\bin',
  [switch]$IncludeBars,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $Root '_meta\research-backup.state.json'
$logFile = Join-Path $Root '_meta\research-backup.log'
$ssh = Join-Path $GitUsrBin 'ssh.exe'
$scp = Join-Path $GitUsrBin 'scp.exe'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$keyArg = $SshKey -replace '\\', '/'
$sshOpts = @('-i', $keyArg, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30')

function Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $logFile -Value $line -Encoding utf8 } catch { }
}

function Test-Excluded([string]$rel) {
  $r = $rel -replace '\\', '/'
  if ($r -eq '_meta/research-backup.state.json' -or $r -eq '_meta/research-backup.log') { return $true }
  if ($r -match '(^|/)__pycache__/' -or $r -like '*.pyc') { return $true }
  if ($r -match '^research/[^/]+/data/') { return $true }
  if (-not $IncludeBars -and $r -like 'bars/*') { return $true }
  return $false
}

foreach ($exe in @($ssh, $scp, $tar)) { if (-not (Test-Path $exe)) { Log "FAILED: $exe not found"; exit 2 } }
if (-not (Test-Path $Root)) { Log "FAILED: $Root not found"; exit 2 }

# 1. Inventory and diff against the last successful run.
$state = @{}
if (Test-Path $stateFile) {
  try { (Get-Content $stateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value } }
  catch { Log "state file unreadable, sending everything: $($_.Exception.Message)" }
}
$rootFull = (Resolve-Path $Root).Path.TrimEnd('\')
$current = @{}
$changed = New-Object System.Collections.Generic.List[string]
$changedBytes = 0L
$totalBytes = 0L
Get-ChildItem -Path $rootFull -Recurse -File -Force | ForEach-Object {
  $rel = $_.FullName.Substring($rootFull.Length + 1)
  if (Test-Excluded $rel) { return }
  $sig = '{0}|{1}' -f $_.Length, $_.LastWriteTimeUtc.Ticks
  $current[$rel] = $sig
  $totalBytes += $_.Length
  if ($state[$rel] -ne $sig) { $changed.Add($rel); $changedBytes += $_.Length }
}
Log ('inventory: {0} files, {1:N1} MB in scope; {2} new/changed ({3:N1} MB)' -f $current.Count, ($totalBytes / 1MB), $changed.Count, ($changedBytes / 1MB))
if ($changed.Count -eq 0) { Log 'nothing changed; done'; exit 0 }

# 2. Archive the changed files (paths relative to the root, forward slashes).
$work = Join-Path ([IO.Path]::GetTempPath()) ('grw-research-backup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $archiveName = "research-$stamp.tar.gz"
  $listFile = Join-Path $work 'files.txt'
  [IO.File]::WriteAllLines($listFile, [string[]]($changed | ForEach-Object { $_ -replace '\\', '/' }), (New-Object Text.UTF8Encoding($false)))
  & $tar -czf (Join-Path $work $archiveName) -C $rootFull -T $listFile
  if ($LASTEXITCODE -ne 0) { throw "tar exited $LASTEXITCODE" }
  $archiveMb = (Get-Item (Join-Path $work $archiveName)).Length / 1MB
  Log ('archive {0}: {1:N1} MB' -f $archiveName, $archiveMb)

  if ($DryRun) {
    Log 'dry run: nothing uploaded, state unchanged'
    $changed | Select-Object -First 25 | ForEach-Object { Write-Host "  $_" }
    if ($changed.Count -gt 25) { Write-Host "  ... and $($changed.Count - 25) more" }
    exit 0
  }

  # 3. Refuse to fill the VPS disk: need the archive twice over (upload + unpack) and stay < 85%.
  $df = & $ssh @sshOpts $Vps "df -B1 --output=size,used,avail / | tail -1"
  if ($LASTEXITCODE -ne 0) { throw "ssh df failed ($LASTEXITCODE)" }
  $parts = ($df -split '\s+') | Where-Object { $_ -ne '' }
  $size = [double]$parts[0]; $used = [double]$parts[1]; $avail = [double]$parts[2]
  $need = 3 * (Get-Item (Join-Path $work $archiveName)).Length
  if (($used + $need) / ($used + $avail) -gt 0.85) {
    throw ('VPS disk would pass 85% ({0:N1} GB used of {1:N1} GB); not uploading' -f ($used / 1GB), ($size / 1GB))
  }

  # 4. Upload and unpack. scp runs from the work dir with a RELATIVE local path: a "C:..." path
  #    would be read by scp as host "C".
  & $ssh @sshOpts $Vps "mkdir -p '$RemoteDir/.incoming' && chmod 755 '$RemoteDir'"
  if ($LASTEXITCODE -ne 0) { throw "ssh mkdir failed ($LASTEXITCODE)" }
  Push-Location $work
  try {
    & $scp @sshOpts -q $archiveName "${Vps}:$RemoteDir/.incoming/"
    if ($LASTEXITCODE -ne 0) { throw "scp failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
  & $ssh @sshOpts $Vps "tar -xzf '$RemoteDir/.incoming/$archiveName' -C '$RemoteDir' --no-same-owner && chmod -R a+rX '$RemoteDir' && rm -f '$RemoteDir/.incoming/$archiveName'"
  if ($LASTEXITCODE -ne 0) { throw "remote unpack failed ($LASTEXITCODE)" }

  # 5. Only now record the new state: a failed run resends the same files next night.
  $current | ConvertTo-Json -Depth 2 | Set-Content -Path $stateFile -Encoding utf8
  Log ('uploaded {0} files ({1:N1} MB archive) to {2}:{3}' -f $changed.Count, $archiveMb, $Vps, $RemoteDir)
  exit 0
}
catch {
  Log "FAILED: $($_.Exception.Message)"
  exit 1
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
