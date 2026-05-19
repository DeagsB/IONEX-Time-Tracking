-- Add not_reimbursable flag to user_expenses.
-- Admin sets this on receipts that should NOT be reimbursed to the employee (e.g. the
-- company paid the cost directly, or the employee isn't entitled to reimbursement on
-- this charge). The row stays in user_expenses so admin can still Apply-to-Ticket and
-- bill the cost to the customer — payroll just skips it and the employee's own
-- expense table hides it.

ALTER TABLE public.user_expenses
  ADD COLUMN IF NOT EXISTS not_reimbursable BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_expenses.not_reimbursable IS
  'Admin override: when true, this receipt is excluded from payroll reimbursement and from the employee''s own expense table, but remains available for Apply-to-Ticket (so the cost can still be billed to a customer).';
