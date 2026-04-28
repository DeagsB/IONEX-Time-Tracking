-- Migration: Add approved_at for expense reimbursement auto-mark-paid and catch-up logic
-- When status/reimbursement_status is set to 'approved', we set approved_at = now().
-- Auto-mark paid: approved expenses in a past period (approved_at <= period end) get status = 'paid'.
-- Re-approved after period end: approved_at > period end → do not auto-mark; include in next pay run.

ALTER TABLE public.user_expenses
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

COMMENT ON COLUMN public.user_expenses.approved_at IS 'Set when status is changed to approved. Used to avoid auto-marking paid when re-approved after period end.';

-- service_ticket_expenses: for needs_reimbursement items, track when reimbursement_status was set to approved
ALTER TABLE public.service_ticket_expenses
  ADD COLUMN IF NOT EXISTS reimbursement_approved_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

COMMENT ON COLUMN public.service_ticket_expenses.reimbursement_approved_at IS 'Set when reimbursement_status is changed to approved. Used for auto-mark paid and catch-up pay.';
