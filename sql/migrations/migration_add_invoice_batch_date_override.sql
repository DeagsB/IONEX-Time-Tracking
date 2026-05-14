-- Add invoice_batch_date_override column for moving tickets between invoice batches
-- on the Invoices page. The actual ticket date is unchanged everywhere (ticket detail,
-- PDFs, Service Tickets page, totals); only invoice batch grouping uses this date when
-- it is set. Used to include e.g. a Mar 30 ticket in the April invoice batch without
-- altering the real ticket date.
--
-- Safe interaction with existing invoiced-batch lock:
--   enforce_invoiced_batch_service_ticket_lock() blocks all UPDATE/DELETE on tickets
--   that are in an invoiced batch (snapshot ticketIds in invoiced_batch_marks). The
--   Invoices UI only allows moves on uninvoiced tickets, so this column will only ever
--   be modified before the ticket is locked into a batch snapshot.

ALTER TABLE public.service_tickets
  ADD COLUMN IF NOT EXISTS invoice_batch_date_override date NULL;

ALTER TABLE public.service_tickets_demo
  ADD COLUMN IF NOT EXISTS invoice_batch_date_override date NULL;

COMMENT ON COLUMN public.service_tickets.invoice_batch_date_override IS
  'When set, the Invoices page groups this ticket into the invoice batch for this date instead of the ticket''s actual date. Does not affect the displayed ticket date or any totals — only batch membership on the Invoices page.';

COMMENT ON COLUMN public.service_tickets_demo.invoice_batch_date_override IS
  'Demo mirror of service_tickets.invoice_batch_date_override.';
