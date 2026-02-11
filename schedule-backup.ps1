# Schedule Supabase database backup every Saturday at 7:00pm
# Run this once to set up the scheduled task. Requires Admin (for Task Scheduler).

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir "backup-config.env"
$taskName = "IONEX Supabase Backup"

# Ensure backup-config.env exists
if (-not (Test-Path $configPath)) {
    Write-Host "backup-config.env not found. Creating from template..." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Get your database connection string from:" -ForegroundColor Gray
    Write-Host "  Supabase Dashboard -> Project Settings -> Database -> Connection string (URI)" -ForegroundColor Gray
    Write-Host "  Replace [YOUR-PASSWORD] with your database password." -ForegroundColor Gray
    Write-Host ""
    $url = Read-Host "Enter SUPABASE_DB_URL (postgresql://postgres....)"
    if (-not $url) {
        Write-Host "No URL provided. Exiting." -ForegroundColor Red
        exit 1
    }
    $content = @"
# Supabase database connection for scheduled backups
# Do not commit this file - it contains secrets
SUPABASE_DB_URL=$url
"@
    Set-Content -Path $configPath -Value $content
    Write-Host "Saved to backup-config.env" -ForegroundColor Green
} else {
    Write-Host "Using existing backup-config.env" -ForegroundColor Cyan
}

# Create/update the scheduled task
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptDir\backup-scheduled.ps1`"" `
    -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At "7:00PM"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Updating existing task '$taskName'..." -ForegroundColor Cyan
    Set-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal
} else {
    Write-Host "Creating scheduled task '$taskName'..." -ForegroundColor Cyan
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal
}

Write-Host ""
Write-Host "Backup scheduled: Every Saturday at 7:00 PM" -ForegroundColor Green
Write-Host "Backups go to: $scriptDir\backups\backup-YYYY-MM-DD-HHmm\" -ForegroundColor Gray
Write-Host "Log file: $scriptDir\backups\backup-schedule.log" -ForegroundColor Gray
Write-Host ""
Write-Host "To run manually: .\backup-scheduled.ps1" -ForegroundColor Gray
Write-Host "To remove the task: Unregister-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
