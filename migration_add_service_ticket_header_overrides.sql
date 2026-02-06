-- Migration: Persist service ticket header overrides (Service Location, Approver/PO/AFE, Other)
-- So user edits to these fields are saved and restored when reopening the ticket

ALTER TABLE public.service_tickets
ADD COLUMN IF NOT EXISTS header_overrides JSONB;

ALTER TABLE public.service_tickets_demo
ADD COLUMN IF NOT EXISTS header_overrides JSONB;

COMMENT ON COLUMN public.service_tickets.header_overrides IS 'User overrides for Service Location, Approver/PO/AFE, Other. Keys: service_location, approver_po_afe, other.';
COMMENT ON COLUMN public.service_tickets_demo.header_overrides IS 'User overrides for Service Location, Approver/PO/AFE, Other. Keys: service_location, approver_po_afe, other.';
