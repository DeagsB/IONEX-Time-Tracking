/**
 * Upload backup files to Supabase Storage (database-backups bucket)
 * Usage: node scripts/upload-backup.js <backup-dir>
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY in env
 */

const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const backupDir = process.argv[2];
if (!backupDir || !fs.existsSync(backupDir)) {
  console.error('Usage: node scripts/upload-backup.js <backup-dir>');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(url, key);
const bucket = 'database-backups';
const folderName = path.basename(backupDir);

async function upload() {
  const files = fs.readdirSync(backupDir);
  for (const file of files) {
    const filePath = path.join(backupDir, file);
    if (!fs.statSync(filePath).isFile()) continue;
    const objectPath = `${folderName}/${file}`;
    const content = fs.readFileSync(filePath);
    const { error } = await supabase.storage.from(bucket).upload(objectPath, content, {
      contentType: file.endsWith('.sql') ? 'application/sql' : 'application/octet-stream',
      upsert: true,
    });
    if (error) {
      console.error(`Failed to upload ${file}:`, error.message);
      process.exit(1);
    }
    console.log(`Uploaded ${objectPath}`);
  }
  console.log('Online backup complete.');
}

upload().catch((err) => {
  console.error(err);
  process.exit(1);
});
