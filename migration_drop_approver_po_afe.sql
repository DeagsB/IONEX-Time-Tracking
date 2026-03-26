-- Full migration: remove approver_po_afe; use approver, po_afe, cc only
-- Run after backup. Use in environments that haven't run via Supabase MCP.
ALTER TABLE public.projects DROP COLUMN IF EXISTS approver_po_afe;
