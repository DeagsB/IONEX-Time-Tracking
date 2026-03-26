-- Migration: Add approved_by_admin_id column to service_tickets tables
-- This stores which admin approved/assigned the ticket number

-- Add column to main service_tickets table
ALTER TABLE public.service_tickets 
ADD COLUMN IF NOT EXISTS approved_by_admin_id UUID REFERENCES public.users(id);

-- Add column to demo service_tickets table
ALTER TABLE public.service_tickets_demo 
ADD COLUMN IF NOT EXISTS approved_by_admin_id UUID REFERENCES public.users(id);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_service_tickets_approved_by_admin 
ON public.service_tickets(approved_by_admin_id);

CREATE INDEX IF NOT EXISTS idx_service_tickets_demo_approved_by_admin 
ON public.service_tickets_demo(approved_by_admin_id);
