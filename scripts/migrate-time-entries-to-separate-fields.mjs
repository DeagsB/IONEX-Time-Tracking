/**
 * One-time migration: backfill approver, po_afe, cc in time_entries
 * from combined po_afe so we can remove parsing from the frontend.
 *
 * Run from project root: node --env-file=backend/.env scripts/migrate-time-entries-to-separate-fields.mjs
 * Requires: SUPABASE_URL and SUPABASE_SERVICE_KEY in backend/.env
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in backend/.env');
  process.exit(1);
}

const supabase = createClient(url, key);

// Inlined parse logic from frontend/src/utils/serviceTickets.ts
function extractACValue(s) {
  const m = s.match(/AC\s*[:\-]?\s*([^\s,;]+)/i);
  return m ? m[1].trim() : '';
}
function extractCcValue(s) {
  const m = s.match(/CC\s*[:\-]?\s*([^\s,;]+)/i);
  return m ? m[1].trim() : '';
}
function extractPoValue(s) {
  const poMatch = s.match(/PO\s*[:\-]?\s*([A-Za-z0-9\-]+)/i);
  if (poMatch) return poMatch[1].trim();
  const inlineMatch = s.match(/([A-Z]{2,}\d{4,}-\d{4,})/i);
  return inlineMatch ? inlineMatch[1].trim() : '';
}
function extractAFEValue(s) {
  const m = s.match(/AFE\s*[:\-]?\s*([^\s,;]+)/i);
  return m ? m[1].trim() : '';
}
function parseApproverPoAfe(combined) {
  const s = (combined || '').trim();
  const explicitAc = extractACValue(s);
  const explicitCc = extractCcValue(s);
  const explicitPo = extractPoValue(s);
  const explicitAfe = extractAFEValue(s);
  const gMatch = s.match(/G\d{3,}/i);
  const approver = explicitAc || (gMatch ? gMatch[0].toUpperCase() : '');
  const remainder = s
    .replace(/AC\s*[:\-]?\s*[^\s,;]+/gi, '')
    .replace(/G\d{3,}\s*/i, '')
    .replace(/CC\s*[:\-]?\s*[^\s,;]+/gi, '')
    .replace(/([A-Z]{2,}\d{4,}-\d{4,})/gi, '')
    .replace(/PO\s*[:\-]?\s*[A-Za-z0-9\-]+/gi, '')
    .replace(/AFE\s*[:\-]?\s*[^\s,;]+/gi, '')
    .trim();
  const isPlainNumber = /^\d{6,10}$/.test(remainder);
  return {
    approver: approver || '',
    poAfe: explicitPo || explicitAfe || (isPlainNumber ? '' : remainder),
    cc: explicitCc || (isPlainNumber ? remainder : ''),
  };
}

async function main() {
  console.log('Migrating time_entries: backfilling approver, po_afe, cc from combined po_afe...\n');

  const { data: rows, error } = await supabase
    .from('time_entries')
    .select('id, po_afe')
    .not('po_afe', 'is', null);

  if (error) {
    console.error('Error fetching time_entries:', error);
    process.exit(1);
  }

  let updated = 0;
  for (const row of rows || []) {
    const combined = (row.po_afe || '').trim();
    if (!combined) continue;

    const { approver, poAfe, cc } = parseApproverPoAfe(combined);

    const { error: updErr } = await supabase
      .from('time_entries')
      .update({
        approver: approver || null,
        po_afe: poAfe || null,
        cc: cc || null,
      })
      .eq('id', row.id);

    if (updErr) {
      console.error(`Error updating ${row.id}:`, updErr);
    } else {
      updated++;
      if (updated <= 20) {
        console.log(`  ${row.id}: approver="${approver}" po_afe="${poAfe}" cc="${cc}"`);
      }
    }
  }

  if (updated > 20) {
    console.log(`  ... and ${updated - 20} more`);
  }
  console.log(`\nDone. Total: ${updated} rows migrated.`);
}

main().catch(console.error);
