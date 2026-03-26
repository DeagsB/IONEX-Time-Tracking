-- Migration: Add per-entry edit overrides to service_tickets tables
-- This allows tracking edits per time entry, so new entries can still flow in
-- while manually edited entries retain their overrides.

-- Add field to service_tickets table
ALTER TABLE public.service_tickets
ADD COLUMN IF NOT EXISTS edited_entry_overrides JSONB;

-- Add field to service_tickets_demo table
ALTER TABLE public.service_tickets_demo
ADD COLUMN IF NOT EXISTS edited_entry_overrides JSONB;

-- Add comments
COMMENT ON COLUMN public.service_tickets.edited_entry_overrides IS 'JSONB object storing per-entry edit overrides. Format: {"entryId": {"description": "...", "st": 1, "tt": 0, "ft": 0, "so": 0, "fo": 0}}. Only entries that differ from their time entry are stored.';
COMMENT ON COLUMN public.service_tickets_demo.edited_entry_overrides IS 'JSONB object storing per-entry edit overrides. Format: {"entryId": {"description": "...", "st": 1, "tt": 0, "ft": 0, "so": 0, "fo": 0}}. Only entries that differ from their time entry are stored.';
