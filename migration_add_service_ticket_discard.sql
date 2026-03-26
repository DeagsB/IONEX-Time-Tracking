-- Migration: Add is_discarded column for soft-delete of service tickets
-- Discarded tickets are hidden from the default view but can be shown with a filter.

ALTER TABLE public.service_tickets
ADD COLUMN IF NOT EXISTS is_discarded BOOLEAN DEFAULT false;

ALTER TABLE public.service_tickets_demo
ADD COLUMN IF NOT EXISTS is_discarded BOOLEAN DEFAULT false;

COMMENT ON COLUMN public.service_tickets.is_discarded IS 'Soft-delete flag. Discarded tickets are hidden from the default view but can be shown with a filter.';
COMMENT ON COLUMN public.service_tickets_demo.is_discarded IS 'Soft-delete flag. Discarded tickets are hidden from the default view but can be shown with a filter.';
