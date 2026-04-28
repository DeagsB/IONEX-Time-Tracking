-- Migration: Add restored_at column for service tickets
-- When a ticket is restored from trash, restored_at is set.
-- The ticket appears at top of list with a green "Restored" indicator until the user interacts (opens) it.

ALTER TABLE public.service_tickets
ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE public.service_tickets_demo
ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.service_tickets.restored_at IS 'Set when ticket is restored from trash. Cleared when user opens/interacts with the ticket. Used to show restored tickets at top with green indicator.';
COMMENT ON COLUMN public.service_tickets_demo.restored_at IS 'Set when ticket is restored from trash. Cleared when user opens/interacts with the ticket.';
