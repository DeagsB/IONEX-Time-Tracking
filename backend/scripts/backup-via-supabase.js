/**
 * Backup Supabase database via REST API (no pg_dump required)
 * Usage: node scripts/backup-via-supabase.js
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY in env
 */

const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(url, key);

const PUBLIC_TABLES = [
  'users', 'customers', 'projects', 'employees', 'time_entries', 'forms',
  'service_tickets', 'service_ticket_expenses', 'service_tickets_demo',
  'bug_reports', 'project_user_assignments', 'customer_user_assignments', 'qbo_tokens'
];

function escape(val) {
  if (val === null) return 'NULL';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  if (val instanceof Date) return "'" + val.toISOString().replace('T', ' ').replace('Z', '+00') + "'";
  if (typeof val === 'object') return "'" + JSON.stringify(val).replace(/'/g, "''") + "'";
  return "'" + String(val).replace(/'/g, "''").replace(/\\/g, '\\\\') + "'";
}

async function fetchAll(table) {
  const rows = [];
  let from = 0;
  const pageSize = 500;
  while (true) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function rowsToSql(table, rows) {
  if (rows.length === 0) return `-- ${table}: 0 rows\n`;
  const cols = Object.keys(rows[0]);
  const lines = [`-- ${table}: ${rows.length} rows`, `INSERT INTO public.${table} (${cols.join(', ')}) VALUES`];
  const values = rows.map(r => '(' + cols.map(c => escape(r[c])).join(', ') + ')');
  lines.push(values.join(',\n'));
  lines.push(';\n');
  return lines.join('\n');
}

async function backup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(__dirname, '../../backups', `backup-${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  console.log('Backing up to', backupDir);

  let fullSql = '-- IONEX Database Backup via Supabase API\n-- ' + new Date().toISOString() + '\n\n';

  for (const table of PUBLIC_TABLES) {
    try {
      const rows = await fetchAll(table);
      const sql = rowsToSql(table, rows);
      fullSql += sql;
      fs.writeFileSync(path.join(backupDir, `${table}.sql`), sql);
      console.log(`  ${table}: ${rows.length} rows`);
    } catch (err) {
      if (err.message.includes('does not exist')) {
        console.log(`  ${table}: (skipped - table not found)`);
      } else {
        throw err;
      }
    }
  }

  fs.writeFileSync(path.join(backupDir, 'backup.sql'), fullSql);
  console.log('Backup complete:', backupDir);
  return backupDir;
}

backup().catch((err) => {
  console.error(err);
  process.exit(1);
});
