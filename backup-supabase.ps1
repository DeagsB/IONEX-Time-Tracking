# Backup Supabase database using Supabase CLI
# Requires: SUPABASE_DB_URL or (SUPABASE_URL + SUPABASE_SERVICE_KEY)
# Loads from backup-config.env or .env if vars not set
# Docs: BACKUP_SUPABASE.md

$ErrorActionPreference = "Stop"

# Load credentials if not already set
if (-not $env:SUPABASE_DB_URL -and (-not $env:SUPABASE_URL -or -not $env:SUPABASE_SERVICE_KEY)) {
    $configPaths = @(
        (Join-Path $PSScriptRoot "backup-config.env"),
        (Join-Path $PSScriptRoot ".env")
    )
    foreach ($p in $configPaths) {
        if (Test-Path $p) {
            Get-Content $p | ForEach-Object {
                if ($_ -match '^\s*([^#=]+)=(.*)$') {
                    $key = $matches[1].Trim()
                    $val = $matches[2].Trim() -replace '^["'']|["'']$'
                    Set-Item -Path "Env:$key" -Value $val -Force
                }
            }
            Write-Host "Loaded config from $p" -ForegroundColor Gray
            break
        }
    }
}

$url = $env:SUPABASE_DB_URL
$hasApiCreds = $env:SUPABASE_URL -and $env:SUPABASE_SERVICE_KEY
if (-not $url -and -not $hasApiCreds) {
    Write-Host "Set SUPABASE_DB_URL or (SUPABASE_URL + SUPABASE_SERVICE_KEY) in backup-config.env" -ForegroundColor Yellow
    exit 1
}

# Check for pg_dump (preferred when SUPABASE_DB_URL is set)
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
$usePgDump = $false
$useSupabaseApi = $false
if ($pgDump -and $url) {
    $usePgDump = $true
    Write-Host "Using pg_dump (PostgreSQL native tool)" -ForegroundColor Cyan
} elseif ($env:SUPABASE_URL -and $env:SUPABASE_SERVICE_KEY) {
    # Use Supabase REST API via Node (no pg_dump or Docker needed)
    $useSupabaseApi = $true
    Write-Host "Using Supabase API (Node.js)" -ForegroundColor Cyan
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
if (-not $useSupabaseApi) {
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $backupDir = (Resolve-Path $backupDir).Path
}

Write-Host "Backing up to backups\" -ForegroundColor Cyan

try {
    if ($useSupabaseApi) {
        $backupScript = Join-Path $PSScriptRoot "backend\scripts\backup-via-supabase.js"
        & node $backupScript
        if ($LASTEXITCODE -ne 0) { throw "Supabase API backup failed" }
        $backupDir = (Get-ChildItem (Join-Path $PSScriptRoot "backups") -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    } elseif ($usePgDump) {
        Push-Location $backupDir
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
    Get-ChildItem $backupDir -File | ForEach-Object { Write-Host "  $($_.Name)" -ForegroundColor Gray }

    # Upload to Supabase Storage if configured
    if ($env:SUPABASE_URL -and $env:SUPABASE_SERVICE_KEY) {
        Write-Host "Uploading to Supabase Storage..." -ForegroundColor Cyan
        $uploadScript = Join-Path $PSScriptRoot "backend\scripts\upload-backup.js"
        if (Test-Path $uploadScript) {
            & node $uploadScript $backupDir
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Online backup complete." -ForegroundColor Green
            } else {
                Write-Host "Online upload failed (local backup saved)." -ForegroundColor Yellow
            }
        } else {
            Write-Host "Upload script not found, skipping online backup." -ForegroundColor Yellow
        }
    }
}
finally {
    Pop-Location
}
