# Backup Supabase database using Supabase CLI
# Requires: Supabase CLI installed, SUPABASE_DB_URL set to your connection string
# Docs: BACKUP_SUPABASE.md

$ErrorActionPreference = "Stop"

$url = $env:SUPABASE_DB_URL
if (-not $url) {
    Write-Host "SUPABASE_DB_URL is not set." -ForegroundColor Yellow
    Write-Host "Set it to your database connection string from Supabase Dashboard -> Project Settings -> Database"
    Write-Host "Example: `$env:SUPABASE_DB_URL = 'postgresql://postgres.[ref]:[password]@...'" -ForegroundColor Gray
    exit 1
}

# Check for pg_dump (preferred for remote databases, no Docker needed)
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
$usePgDump = $false
if ($pgDump) {
    $usePgDump = $true
    Write-Host "Using pg_dump (PostgreSQL native tool)" -ForegroundColor Cyan
} else {
    # Fallback to Supabase CLI (requires Docker for some operations)
    $cli = Get-Command supabase -ErrorAction SilentlyContinue
    $useNpx = $false
    if (-not $cli) {
        # Try npx as fallback (doesn't require installation)
        $npx = Get-Command npx -ErrorAction SilentlyContinue
        if ($npx) {
            $useNpx = $true
            Write-Host "Using npx supabase (may require Docker)" -ForegroundColor Yellow
        } else {
            Write-Host "Neither pg_dump nor Supabase CLI found." -ForegroundColor Yellow
            Write-Host "Install PostgreSQL (includes pg_dump) or Supabase CLI:" -ForegroundColor Gray
            Write-Host "  PostgreSQL: https://www.postgresql.org/download/windows/" -ForegroundColor Gray
            Write-Host "  Supabase CLI: scoop install supabase" -ForegroundColor Gray
            exit 1
        }
    }
}

$timestamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$backupDir = Join-Path $PSScriptRoot "backups\backup-$timestamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$backupDir = (Resolve-Path $backupDir).Path

Write-Host "Backing up to $backupDir" -ForegroundColor Cyan

Push-Location $backupDir
try {
    if ($usePgDump) {
        # Use pg_dump directly (works for remote databases, no Docker needed)
        Write-Host "Dumping full database (schema + data)..." -ForegroundColor Gray
        & pg_dump $url --no-owner --no-acl -f backup.sql
        if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
        
        # Also create separate files for convenience
        Write-Host "Creating schema-only backup..." -ForegroundColor Gray
        & pg_dump $url --no-owner --no-acl --schema-only -f schema.sql
        if ($LASTEXITCODE -ne 0) { throw "schema dump failed" }
        
        Write-Host "Creating data-only backup..." -ForegroundColor Gray
        & pg_dump $url --no-owner --no-acl --data-only -f data.sql
        if ($LASTEXITCODE -ne 0) { throw "data dump failed" }
    } else {
        # Use Supabase CLI (may require Docker)
        Write-Host "Dumping roles..." -ForegroundColor Gray
        if ($useNpx) {
            & npx supabase db dump --db-url $url -f roles.sql --role-only
        } else {
            & supabase db dump --db-url $url -f roles.sql --role-only
        }
        if ($LASTEXITCODE -ne 0) { throw "roles dump failed" }

        Write-Host "Dumping schema..." -ForegroundColor Gray
        if ($useNpx) {
            & npx supabase db dump --db-url $url -f schema.sql
        } else {
            & supabase db dump --db-url $url -f schema.sql
        }
        if ($LASTEXITCODE -ne 0) { throw "schema dump failed" }

        Write-Host "Dumping data..." -ForegroundColor Gray
        if ($useNpx) {
            & npx supabase db dump --db-url $url -f data.sql --use-copy --data-only
        } else {
            & supabase db dump --db-url $url -f data.sql --use-copy --data-only
        }
        if ($LASTEXITCODE -ne 0) { throw "data dump failed" }
    }

    Write-Host "Backup complete: $backupDir" -ForegroundColor Green
    Get-ChildItem -File | ForEach-Object { Write-Host "  $($_.Name)" -ForegroundColor Gray }
}
finally {
    Pop-Location
}
