-- Add actual_cost column to service_ticket_expenses
ALTER TABLE public.service_ticket_expenses
  ADD COLUMN IF NOT EXISTS actual_cost DECIMAL(10, 2);

-- Set default values for existing rows
UPDATE public.service_ticket_expenses
SET actual_cost = rate
WHERE actual_cost IS NULL AND needs_reimbursement = true;

UPDATE public.service_ticket_expenses
SET actual_cost = 0
WHERE actual_cost IS NULL AND needs_reimbursement = false;

COMMENT ON COLUMN public.service_ticket_expenses.actual_cost IS 'The actual cost to the company for this expense, distinct from the billed rate. Default $0 for company-paid items, default equals rate for reimbursed items.';
