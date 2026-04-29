-- Migration: Link service_ticket_expenses to a user_expenses receipt
--
-- Purpose: Employees may add reimbursable expenses to service tickets before
-- they have the receipt (e.g. nightly hotel charges submitted Mon-Fri, single
-- receipt issued at checkout). This column lets us attach a single uploaded
-- receipt (user_expenses row) to one or more service_ticket_expenses rows
-- after the fact. NULL = receipt pending. Receipt amount may differ from sum
-- of linked ticket expenses; the company absorbs the difference.

ALTER TABLE public.service_ticket_expenses
  ADD COLUMN IF NOT EXISTS user_expense_id UUID REFERENCES public.user_expenses(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.service_ticket_expenses.user_expense_id IS
  'Optional link to the user_expenses (receipt) row that covers this ticket expense for reimbursement purposes. NULL = receipt still pending.';

CREATE INDEX IF NOT EXISTS service_ticket_expenses_user_expense_id_idx
  ON public.service_ticket_expenses(user_expense_id);
