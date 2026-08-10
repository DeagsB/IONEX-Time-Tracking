<#
.SYNOPSIS
  Full local backup of the Supabase Postgres database.

.DESCRIPTION
  Writes a timestamped folder under backups/ containing:
    roles.sql   - role definitions (pg_dumpall --roles-only), best effort
    schema.sql  - DDL only, all schemas
    data.sql    - data only, COPY format, all schemas
    backup.sql  - schema + data in one restorable plain-SQL file
    backup.dump - same content in pg_dump custom format (-Fc), for pg_restore
    MANIFEST.txt - sizes, checksums, row counts, server version

  Connection comes from backup-config.env (SUPABASE_DB_URL), which is gitignored.

.NOTES
  Supabase's direct host db.<ref>.supabase.co is IPv6-ONLY.
  NordVPN / NordLynx provides no IPv6, so the dump fails with
  "could not translate host name ... Name or service not known" while it is
  connected. Disconnect the VPN (or use an IPv4 pooler URL) before running.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
#>
[CmdletBinding()]
param(
    # Override the connection string instead of reading backup-config.env.
    [string]$DbUrl,
    # Where backup folders are created.
    [string]$OutRoot
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutRoot) { $OutRoot = Join-Path $repoRoot 'backups' }

# --- locate pg_dump (newest major version wins) -----------------------------
function Get-PgBinDir {
    $candidates = @()
    $pgRoot = 'C:\Program Files\PostgreSQL'
    if (Test-Path $pgRoot) {
        $candidates += Get-ChildItem $pgRoot -Directory |
            Where-Object { $_.Name -match '^\d+$' } |
            Sort-Object { [int]$_.Name } -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin' }
    }
    $onPath = Get-Command pg_dump -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += Split-Path -Parent $onPath.Source }

    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c 'pg_dump.exe')) { return $c }
    }
    throw "pg_dump.exe not found. Install PostgreSQL client tools or add pg_dump to PATH."
}

$binDir  = Get-PgBinDir
$pgDump  = Join-Path $binDir 'pg_dump.exe'
$pgDumpAll = Join-Path $binDir 'pg_dumpall.exe'
$psqlExe = Join-Path $binDir 'psql.exe'

# --- connection string ------------------------------------------------------
if (-not $DbUrl) {
    $cfg = Join-Path $repoRoot 'backup-config.env'
    if (-not (Test-Path $cfg)) { throw "backup-config.env not found at $cfg and -DbUrl was not supplied." }
    $line = Get-Content $cfg | Where-Object { $_ -match '^\s*SUPABASE_DB_URL\s*=' } | Select-Object -First 1
    if (-not $line) { throw "SUPABASE_DB_URL missing from $cfg" }
    $DbUrl = ($line -replace '^\s*SUPABASE_DB_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
}

# Host shown in logs; password is never printed.
$dbHost = if ($DbUrl -match '@([^/:]+)') { $Matches[1] } else { '<unknown>' }

# --- preflight: can we resolve and reach the host? --------------------------
Write-Host "pg_dump   : $((& $pgDump --version) -join '')"
Write-Host "host      : $dbHost"

$reachable = $false
try {
    $probe = Test-NetConnection -ComputerName $dbHost -Port 5432 -WarningAction SilentlyContinue
    $reachable = [bool]$probe.TcpTestSucceeded
} catch { $reachable = $false }

if (-not $reachable) {
    $hasV6 = @(Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |
               Where-Object { $_.IPAddress -notlike 'fe80*' -and $_.IPAddress -ne '::1' }).Count -gt 0
    $vpnUp = @(Get-NetAdapter -ErrorAction SilentlyContinue |
               Where-Object { $_.Status -eq 'Up' -and $_.Name -match 'NordLynx|NordVPN|OpenVPN|WireGuard' }).Count -gt 0
    $msg = "Cannot reach $dbHost on port 5432."
    if (-not $hasV6) { $msg += "`n  - This machine has NO global IPv6 address, and Supabase's direct host is IPv6-only." }
    if ($vpnUp)      { $msg += "`n  - A VPN adapter is Up (NordLynx/NordVPN blocks IPv6). Disconnect it and retry." }
    $msg += "`n  - Alternative: pass -DbUrl with the IPv4 Session-mode pooler string from the Supabase dashboard."
    throw $msg
}

# --- output folder ----------------------------------------------------------
$stamp   = Get-Date -Format 'yyyy-MM-dd-HHmm'
$outDir  = Join-Path $OutRoot "backup-$stamp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Write-Host "output    : $outDir"
Write-Host ""

function Invoke-Dump {
    param([string]$Label, [string]$Exe, [string[]]$DumpArgs, [switch]$Optional)

    Write-Host ("-> {0}" -f $Label)
    $errFile = Join-Path $env:TEMP "pgdump-$([guid]::NewGuid().ToString('N')).err"
    & $Exe @DumpArgs 2> $errFile
    $code = $LASTEXITCODE
    $stderr = ''
    if (Test-Path $errFile) {
        $raw = Get-Content $errFile -Raw
        if ($null -ne $raw) { $stderr = [string]$raw }
    }
    Remove-Item $errFile -ErrorAction SilentlyContinue

    if ($code -ne 0) {
        if ($Optional) {
            Write-Warning "$Label failed (exit $code) - continuing. $($stderr.Trim())"
            return $false
        }
        throw "$Label failed (exit $code).`n$stderr"
    }
    if ($stderr.Trim()) { Write-Warning "$Label stderr: $($stderr.Trim())" }
    return $true
}

$rolesPath  = Join-Path $outDir 'roles.sql'
$schemaPath = Join-Path $outDir 'schema.sql'
$dataPath   = Join-Path $outDir 'data.sql'
$fullPath   = Join-Path $outDir 'backup.sql'
$dumpPath   = Join-Path $outDir 'backup.dump'

# Roles are cluster-level; on hosted Supabase this is partial by design.
Invoke-Dump -Label 'roles.sql'   -Exe $pgDumpAll -Optional -DumpArgs @(
    '--dbname', $DbUrl, '--roles-only', '--no-role-passwords', '--file', $rolesPath) | Out-Null

Invoke-Dump -Label 'schema.sql'  -Exe $pgDump -DumpArgs @(
    $DbUrl, '--schema-only', '--file', $schemaPath) | Out-Null

Invoke-Dump -Label 'data.sql'    -Exe $pgDump -DumpArgs @(
    $DbUrl, '--data-only', '--file', $dataPath) | Out-Null

Invoke-Dump -Label 'backup.sql'  -Exe $pgDump -DumpArgs @(
    $DbUrl, '--file', $fullPath) | Out-Null

# Custom format: compressed and restorable selectively with pg_restore.
Invoke-Dump -Label 'backup.dump' -Exe $pgDump -DumpArgs @(
    $DbUrl, '--format', 'custom', '--file', $dumpPath) | Out-Null

# --- manifest ---------------------------------------------------------------
Write-Host ""
Write-Host "-> MANIFEST.txt"

$serverVersion = ''
try { $serverVersion = (& $psqlExe $DbUrl -Atc 'select version();') -join '' } catch { $serverVersion = '(unavailable)' }

$rowCounts = ''
try {
    $sql = @'
select table_schema || '.' || table_name || ' = ' ||
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                           false, true, '')))[1]::text::bigint
from information_schema.tables
where table_type = 'BASE TABLE'
  and table_schema not in ('pg_catalog','information_schema','pg_toast')
order by 1;
'@
    $rowCounts = (& $psqlExe $DbUrl -Atc $sql) -join "`n"
} catch { $rowCounts = '(row counts unavailable)' }

$lines = @()
$lines += "IONEX Time Tracker - database backup"
$lines += "created : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')"
$lines += "host    : $dbHost"
$lines += "pg_dump : $((& $pgDump --version) -join '')"
$lines += "server  : $serverVersion"
$lines += ""
$lines += "files:"
foreach ($f in Get-ChildItem $outDir -File | Sort-Object Name) {
    $sha = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
    $lines += ("  {0,-14} {1,12:N0} bytes  sha256={2}" -f $f.Name, $f.Length, $sha)
}
$lines += ""
$lines += "row counts at backup time:"
foreach ($rc in ($rowCounts -split "`n")) { if ($rc.Trim()) { $lines += "  $rc" } }
$lines += ""
$lines += "restore:"
$lines += "  psql `"<target-db-url>`" -f backup.sql"
$lines += "  # or selectively:"
$lines += "  pg_restore --dbname `"<target-db-url>`" --clean --if-exists backup.dump"
$lines += ""
$lines += "NOTE: Supabase Storage objects (bucket files such as invoiced-batch-invoices,"
$lines += "      service-ticket-pdfs) are NOT included - only the storage.* metadata tables."

$lines -join "`r`n" | Out-File -FilePath (Join-Path $outDir 'MANIFEST.txt') -Encoding utf8

Write-Host ""
Write-Host "Backup complete: $outDir" -ForegroundColor Green
Get-ChildItem $outDir -File | Sort-Object Name |
    Select-Object Name, @{n='Size';e={'{0:N0}' -f $_.Length}} | Format-Table -AutoSize
