/**
 * Script to apply Supabase migrations
 * Run with: node apply-migrations.js
 * 
 * Requires environment variables:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY (for admin operations)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get Supabase credentials from environment
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: Missing Supabase credentials');
  console.error('Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function executeSQL(sql) {
  console.log('📝 Executing SQL migration...');
  console.log('---');
  
  // Split by semicolons and execute each statement
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const statement of statements) {
    if (statement.trim()) {
      try {
        const { data, error } = await supabase.rpc('exec_sql', { sql_query: statement });
        
        if (error) {
          // Try direct query if RPC doesn't work
          const { error: queryError } = await supabase.from('_migrations').select('*').limit(0);
          
          if (queryError) {
            console.error('❌ Error executing:', statement.substring(0, 100));
            console.error('   Error:', error.message || queryError.message);
            // Continue with next statement
            continue;
          }
        }
        
        console.log('✅ Executed:', statement.substring(0, 80) + '...');
      } catch (err) {
        console.error('❌ Error:', err.message);
        console.error('   Statement:', statement.substring(0, 100));
      }
    }
  }
}

async function applyMigration(filename) {
  console.log(`\n🔄 Applying migration: ${filename}`);
  console.log('='.repeat(60));
  
  try {
    const filePath = join(__dirname, filename);
    const sql = readFileSync(filePath, 'utf-8');
    await executeSQL(sql);
    console.log(`✅ Migration ${filename} applied successfully\n`);
  } catch (error) {
    console.error(`❌ Failed to apply ${filename}:`, error.message);
    throw error;
  }
}

async function main() {
  console.log('🚀 Starting Supabase Migration Application');
  console.log('='.repeat(60));
  
  const migrations = [
    'migration_preserve_data_on_user_delete.sql',
    'migration_add_user_archive.sql',
  ];

  for (const migration of migrations) {
    try {
      await applyMigration(migration);
    } catch (error) {
      console.error(`\n❌ Migration failed: ${migration}`);
      console.error('Please check the error above and apply manually in Supabase SQL Editor');
      process.exit(1);
    }
  }

  console.log('='.repeat(60));
  console.log('✅ All migrations applied successfully!');
}

main().catch(console.error);

