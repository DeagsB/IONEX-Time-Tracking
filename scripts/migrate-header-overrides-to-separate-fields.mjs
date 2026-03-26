/**
 * One-time migration: backfill approver, po_afe, cc in header_overrides
 * from approver_po_afe so we can remove parsing from the frontend.
 *
 * Run from project root: cd backend && node -r dotenv/config ../scripts/migrate-header-overrides-to-separate-fields.mjs
 * Or: node --env-file=backend/.env scripts/migrate-header-overrides-to-separate-fields.mjs (Node 20+)
 * Requires: SUPABASE_URL and SUPABASE_SERVICE_KEY in backend/.env
 */

import { createClient } from '@supabase/supabase-js';

// Run from backend: cd backend && node -r dotenv/config ../scripts/migrate-header-overrides-to-separate-fields.mjs
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

async function migrateTable(tableName) {
  const { data: rows, error } = await supabase
    .from(tableName)
    .select('id, header_overrides')
    .not('header_overrides', 'is', null);

  if (error) {
    console.error(`Error fetching ${tableName}:`, error);
    return 0;
  }

  let updated = 0;
  for (const row of rows || []) {
    const ov = row.header_overrides || {};
    const apa = ov.approver_po_afe;
    const hasSeparate = (ov.approver != null && String(ov.approver).trim() !== '') ||
      (ov.po_afe != null && String(ov.po_afe).trim() !== '') ||
      (ov.cc != null && String(ov.cc).trim() !== '');

    if (!apa || hasSeparate) continue;

    const { approver, poAfe, cc } = parseApproverPoAfe(apa);
    const newOverrides = { ...ov, approver, po_afe: poAfe, cc };

    const { error: updErr } = await supabase
      .from(tableName)
      .update({ header_overrides: newOverrides })
      .eq('id', row.id);

    if (updErr) {
      console.error(`Error updating ${row.id} in ${tableName}:`, updErr);
    } else {
      updated++;
      console.log(`  ${row.id}: "${apa}" -> approver="${approver}" po_afe="${poAfe}" cc="${cc}"`);
    }
  }
  return updated;
}

async function main() {
  console.log('Migrating header_overrides: backfilling approver, po_afe, cc from approver_po_afe...\n');

  const n1 = await migrateTable('service_tickets');
  console.log(`\nservice_tickets: ${n1} updated`);

  const n2 = await migrateTable('service_tickets_demo');
  console.log(`service_tickets_demo: ${n2} updated`);

  console.log(`\nDone. Total: ${n1 + n2} rows migrated.`);
}

main().catch(console.error);
