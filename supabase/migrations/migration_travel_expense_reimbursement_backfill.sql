-- Backfill: Travel (Mileage/Truck Hours) lines historically defaulted needs_reimbursement=false in the DB
-- but payroll, employee reports, and profitability always applied mileage reimbursement.
-- After adding "company vehicle" (billed-only, no employee reimbursement), only rows that stay false are intentional.
-- This one-time update marks all existing Travel expenses as reimbursable so behavior matches history.

UPDATE public.service_ticket_expenses
SET needs_reimbursement = true
WHERE LOWER(TRIM(expense_type::text)) = 'travel';
