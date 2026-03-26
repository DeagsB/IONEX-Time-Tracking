-- Migration: Add gst and is_billable fields to user_expenses
-- Supports billable receipt tracking and GST separation

ALTER TABLE public.user_expenses
  ADD COLUMN IF NOT EXISTS gst DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_billable BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS markup_amount DECIMAL(10, 2) DEFAULT 0;

COMMENT ON COLUMN public.user_expenses.gst IS 'GST amount included in the expense total.';
COMMENT ON COLUMN public.user_expenses.is_billable IS 'Whether this expense is billable to a client via a service ticket.';
COMMENT ON COLUMN public.user_expenses.markup_amount IS 'Markup applied when adding expense to a service ticket.';
