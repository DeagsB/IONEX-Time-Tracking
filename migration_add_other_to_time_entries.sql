-- Add other column to time_entries for bidirectional sync with service ticket header_overrides.
-- Enables Other field to flow: time entry <-> service ticket (like approver, po_afe, cc).
ALTER TABLE public.time_entries
ADD COLUMN IF NOT EXISTS other TEXT;

COMMENT ON COLUMN public.time_entries.other IS 'Other notes - syncs with service ticket header_overrides.other';
