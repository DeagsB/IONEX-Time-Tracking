# Scheduled backup wrapper
# Loads SUPABASE_DB_URL from backup-config.env and runs backup-supabase.ps1
# Use with Task Scheduler for automated Saturday 7pm backups.

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Load config (backup-config.env in repo root)
$configPath = Join-Path $scriptDir "backup-config.env"
if (-not (Test-Path $configPath)) {
    $logPath = Join-Path $scriptDir "backups\backup-schedule.log"
    $logDir = Split-Path -Parent $logPath
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    $msg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - ERROR: backup-config.env not found. Run schedule-backup.ps1 first."
    Add-Content -Path $logPath -Value $msg
    Write-Host $msg -ForegroundColor Red
    exit 1
}

Get-Content $configPath | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        $key = $matches[1].Trim()
        $val = $matches[2].Trim()
        Set-Item -Path "Env:$key" -Value $val
    }
}

if (-not $env:SUPABASE_DB_URL) {
    $logPath = Join-Path $scriptDir "backups\backup-schedule.log"
    $logDir = Split-Path -Parent $logPath
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    $msg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - ERROR: SUPABASE_DB_URL not set in backup-config.env"
    Add-Content -Path $logPath -Value $msg
    Write-Host $msg -ForegroundColor Red
    exit 1
}

# Log start
$logPath = Join-Path $scriptDir "backups\backup-schedule.log"
$logDir = Split-Path -Parent $logPath
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
Add-Content -Path $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Starting scheduled backup"

try {
    & (Join-Path $scriptDir "backup-supabase.ps1")
    Add-Content -Path $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Backup completed successfully"
} catch {
    Add-Content -Path $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Backup FAILED: $_"
    throw
}
