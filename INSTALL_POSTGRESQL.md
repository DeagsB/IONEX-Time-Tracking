# Install PostgreSQL for Database Backups

PostgreSQL includes `pg_dump`, which allows you to backup your Supabase database without Docker.

## Quick Install Steps

1. **Download PostgreSQL:**
   - Go to: https://www.postgresql.org/download/windows/
   - Click "Download the installer" (recommended: latest version, e.g., PostgreSQL 17)
   - Run the downloaded `.exe` file

2. **Installation Wizard:**
   - Click "Next" through the setup wizard
   - **Important:** When you reach "Select Components", make sure **"Command Line Tools"** is checked (this includes `pg_dump`)
   - Choose an installation directory (default is fine)
   - Set a password for the `postgres` superuser (you can use a simple one like `postgres` - this is just for local PostgreSQL, not your Supabase database)
   - Choose a port (default 5432 is fine)
   - Complete the installation

3. **Add to PATH (if not done automatically):**
   - The installer usually adds PostgreSQL to your PATH automatically
   - If `pg_dump` doesn't work after installation, manually add:
     - `C:\Program Files\PostgreSQL\17\bin` (or your version number)
   - To add to PATH:
     1. Press `Win + X` → System → Advanced system settings
     2. Click "Environment Variables"
     3. Under "System variables", find "Path" → Edit
     4. Click "New" and add: `C:\Program Files\PostgreSQL\17\bin`
     5. Click OK on all dialogs
     6. **Restart your terminal/PowerShell**

4. **Verify Installation:**
   Open a **new** PowerShell window and run:
   ```powershell
   pg_dump --version
   ```
   You should see something like: `pg_dump (PostgreSQL) 17.x`

5. **Run the Backup:**
   ```powershell
   cd "path/to/IONEX-Time-Tracking"
   $env:SUPABASE_DB_URL = 'postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres'
   .\backup-supabase.ps1
   ```
   
   > **Note**: Replace `YOUR_PROJECT_REF` with your Supabase project reference (found in Supabase Dashboard → Settings → General) and `YOUR_PASSWORD` with your database password.

## Alternative: Portable PostgreSQL

If you don't want to install PostgreSQL system-wide, you can use a portable version:
- Download: https://www.enterprisedb.com/download-postgresql-binaries
- Extract to a folder (e.g., `C:\tools\postgresql`)
- Use the full path in the backup script or add that `bin` folder to PATH temporarily

## Troubleshooting

- **"pg_dump is not recognized"**: PostgreSQL bin folder is not in PATH. Add it manually (step 3 above) and restart your terminal.
- **Connection refused**: Check your Supabase connection string and password.
- **SSL required**: Supabase requires SSL. The connection string should work, but if you get SSL errors, add `?sslmode=require` to the end of your connection string.
