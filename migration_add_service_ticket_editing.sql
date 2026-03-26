-- Migration: Add fields to service_tickets tables to support editing descriptions and hours
-- This allows admins to edit service ticket descriptions and hours without affecting time entries

-- Add fields to service_tickets table
ALTER TABLE public.service_tickets
ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS edited_descriptions JSONB,
ADD COLUMN IF NOT EXISTS edited_hours JSONB;

-- Add fields to service_tickets_demo table
ALTER TABLE public.service_tickets_demo
ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS edited_descriptions JSONB,
ADD COLUMN IF NOT EXISTS edited_hours JSONB;

-- Add comments
COMMENT ON COLUMN public.service_tickets.is_edited IS 'Flag indicating if this ticket has been manually edited. When true, time entry changes will not update the ticket.';
COMMENT ON COLUMN public.service_tickets.edited_descriptions IS 'JSONB object storing edited descriptions by rate type. Format: {"Shop Time": ["desc1", "desc2"], "Field Time": ["desc3"]}';
COMMENT ON COLUMN public.service_tickets.edited_hours IS 'JSONB object storing edited hours by rate type. Format: {"Shop Time": 4.5, "Field Time": 2.0}';

COMMENT ON COLUMN public.service_tickets_demo.is_edited IS 'Flag indicating if this ticket has been manually edited. When true, time entry changes will not update the ticket.';
COMMENT ON COLUMN public.service_tickets_demo.edited_descriptions IS 'JSONB object storing edited descriptions by rate type. Format: {"Shop Time": ["desc1", "desc2"], "Field Time": ["desc3"]}';
COMMENT ON COLUMN public.service_tickets_demo.edited_hours IS 'JSONB object storing edited hours by rate type. Format: {"Shop Time": 4.5, "Field Time": 2.0}';
