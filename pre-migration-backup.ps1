# Pre-migration database backup
# Run this BEFORE running the full migration to drop approver_po_afe.
# Creates a backup in backups/backup-YYYY-MM-DD-HHmm/ with a PRE-MIGRATION marker.

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Load config (backup-config.env in repo root)
$configPath = Join-Path $scriptDir "backup-config.env"
if (-not (Test-Path $configPath)) {
    Write-Host ""
    Write-Host "backup-config.env not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "To create a backup before migration:" -ForegroundColor Yellow
    Write-Host "1. Copy backup-config.env.example to backup-config.env" -ForegroundColor Gray
    Write-Host "   Copy-Item backup-config.env.example backup-config.env" -ForegroundColor Gray
    Write-Host ""
    Write-Host "2. Edit backup-config.env and add one of:" -ForegroundColor Gray
    Write-Host "   - SUPABASE_DB_URL (from Supabase Dashboard -> Project Settings -> Database)" -ForegroundColor Gray
    Write-Host "   - OR SUPABASE_URL + SUPABASE_SERVICE_KEY (from Project Settings -> API)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "3. Run this script again: .\pre-migration-backup.ps1" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Alternatively, use Supabase Dashboard -> Database -> Backups to download a backup." -ForegroundColor Cyan
    exit 1
}

Get-Content $configPath | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        $key = $matches[1].Trim()
        $val = $matches[2].Trim()
        Set-Item -Path "Env:$key" -Value $val
    }
}

$hasDbUrl = $env:SUPABASE_DB_URL
$hasApiCreds = $env:SUPABASE_URL -and $env:SUPABASE_SERVICE_KEY
if (-not $hasDbUrl -and -not $hasApiCreds) {
    Write-Host "Set SUPABASE_DB_URL or (SUPABASE_URL + SUPABASE_SERVICE_KEY) in backup-config.env" -ForegroundColor Red
    exit 1
}

Write-Host "Creating PRE-MIGRATION backup..." -ForegroundColor Cyan
Write-Host ""

try {
    & (Join-Path $scriptDir "backup-supabase.ps1")
    $latestBackup = Get-ChildItem (Join-Path $scriptDir "backups") -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestBackup) {
        $markerPath = Join-Path $latestBackup.FullName "PRE-MIGRATION-BACKUP.txt"
        @"
Pre-migration backup
Created: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Purpose: Restore point before dropping approver_po_afe column and full migration to approver, po_afe, cc columns.
"@ | Set-Content -Path $markerPath
        Write-Host ""
        Write-Host "Pre-migration backup complete: $($latestBackup.FullName)" -ForegroundColor Green
        Write-Host "Marker file: PRE-MIGRATION-BACKUP.txt" -ForegroundColor Gray
    }
} catch {
    Write-Host "Backup failed: $_" -ForegroundColor Red
    exit 1
}
