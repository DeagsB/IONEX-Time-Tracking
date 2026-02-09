-- Add rejection_notes to service_tickets and service_tickets_demo.
-- When an admin rejects a ticket, they can provide a reason; the user sees it at the top of the ticket in Drafts.

ALTER TABLE public.service_tickets
  ADD COLUMN IF NOT EXISTS rejection_notes TEXT;

ALTER TABLE public.service_tickets_demo
  ADD COLUMN IF NOT EXISTS rejection_notes TEXT;

COMMENT ON COLUMN public.service_tickets.rejection_notes IS 'Admin reason for rejection; shown to user when they open the rejected ticket in Drafts.';
COMMENT ON COLUMN public.service_tickets_demo.rejection_notes IS 'Admin reason for rejection.';
