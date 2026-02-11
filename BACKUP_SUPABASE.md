# Supabase database backup

Ways to create a backup of your Supabase database for the IONEX Time Tracking project.

---

## Option 0: Scheduled backup (every Saturday at 7:00pm)

To run backups automatically every Saturday at 7:00pm:

1. **Run the setup script once** (from the repo root):

   ```powershell
   .\schedule-backup.ps1
   ```

2. On first run, it will prompt for your `SUPABASE_DB_URL` and save it to `backup-config.env` (gitignored).

3. A Windows Task Scheduler task **"IONEX Supabase Backup"** is created. It runs every Saturday at 7:00pm.

4. Backups are written to `backups/backup-YYYY-MM-DD-HHmm/`.
5. Log output: `backups/backup-schedule.log`.

**Manual run:** `.\backup-scheduled.ps1`  
**Remove schedule:** `Unregister-ScheduledTask -TaskName "IONEX Supabase Backup"`

---

## Option 1: Supabase Dashboard (easiest if you’re on Pro or higher)

1. Open your project: **[Supabase Dashboard](https://supabase.com/dashboard)** → select the IONEX project.
2. Go to **Database** → **Backups**.
3. Under **Scheduled backups** you’ll see daily backups (Pro/Team/Enterprise).
4. Use **Download** on a backup to get a `.sql` file.

> If you’re on the free tier, scheduled backups may be limited or unavailable. Use Option 2 for a manual backup.

---

## Option 2: Manual backup with Supabase CLI (any plan)

Creates a full logical backup (roles + schema + data) on your machine.

### 1. Install Supabase CLI

- **Windows (Scoop):**
  ```powershell
  scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
  scoop install supabase
  ```
- **Or with npm:**  
  `npx supabase --version` (no install), or `npm install supabase --save-dev`

### 2. Get the database connection string

1. In the [Supabase Dashboard](https://supabase.com/dashboard), open your IONEX project.
2. Go to **Project Settings** (gear) → **Database**.
3. Under **Connection string** choose **URI** and copy it.
4. Replace `[YOUR-PASSWORD]` with your **database password** (Project Settings → Database → Reset database password if needed).

Example format:

- **Session pooler:**  
  `postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`
- **Direct:**  
  `postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres`

### 3. Run the backup script

From the repo root:

```powershell
# Set your connection string (avoid committing this)
$env:SUPABASE_DB_URL = "postgresql://postgres.[PROJECT-REF]:YOUR_PASSWORD@...."

# Run the backup
.\backup-supabase.ps1
```

Backups are written under `backups/backup-YYYY-MM-DD-HHmm/` (roles, schema, and data).

### 4. Run CLI commands manually (no script)

If you prefer not to use the script:

```powershell
# Create a folder for this backup
$dir = "backups/backup-$(Get-Date -Format 'yyyy-MM-dd-HHmm')"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
cd $dir

# Replace with your actual connection string
$url = $env:SUPABASE_DB_URL

supabase db dump --db-url $url -f roles.sql --role-only
supabase db dump --db-url $url -f schema.sql
supabase db dump --db-url $url -f data.sql --use-copy --data-only
```

---

## Restoring from a backup

- **Dashboard backup:** use **Database** → **Backups** → choose backup → **Restore** (see [Supabase docs](https://supabase.com/docs/guides/platform/backups)).
- **CLI backup (roles + schema + data):** use `psql` with the **new** project’s connection string and run the `.sql` files in order (roles → schema → data). Full steps: [Backup and restore via CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

---

## Project reference

Your IONEX app uses the Supabase project whose URL is in `VITE_SUPABASE_URL` (e.g. in Vercel or local env). The project ref is the part before `.supabase.co` in that URL.
