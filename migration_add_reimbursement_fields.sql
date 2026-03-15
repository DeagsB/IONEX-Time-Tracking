-- Migration: Add reimbursement rate columns to employees and reimbursement tracking to service_ticket_expenses

-- 1. Employee-specific reimbursement rates (multiplier: 0.90 = 90%)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS mileage_reimb_rate DECIMAL(10, 2) DEFAULT 0.90,
  ADD COLUMN IF NOT EXISTS truck_reimb_rate DECIMAL(10, 2) DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS per_diem_reimb_rate DECIMAL(10, 2) DEFAULT 1.00;

COMMENT ON COLUMN public.employees.mileage_reimb_rate IS 'Reimbursement rate multiplier for mileage expenses (e.g. 0.90 = 90%).';
COMMENT ON COLUMN public.employees.truck_reimb_rate IS 'Reimbursement rate multiplier for truck hour expenses (e.g. 1.00 = 100%).';
COMMENT ON COLUMN public.employees.per_diem_reimb_rate IS 'Reimbursement rate multiplier for per diem expenses (e.g. 1.00 = 100%).';

-- 2. Reimbursement tracking on service ticket expenses
ALTER TABLE public.service_ticket_expenses
  ADD COLUMN IF NOT EXISTS needs_reimbursement BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reimbursement_status TEXT DEFAULT NULL;

-- Add check constraint separately so it only applies to non-null values
DO $$ BEGIN
  ALTER TABLE public.service_ticket_expenses
    ADD CONSTRAINT service_ticket_expenses_reimbursement_status_check
    CHECK (reimbursement_status IS NULL OR reimbursement_status IN ('pending', 'approved', 'rejected', 'paid'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.service_ticket_expenses.needs_reimbursement IS 'Whether this expense line item needs to be reimbursed to the employee.';
COMMENT ON COLUMN public.service_ticket_expenses.reimbursement_status IS 'Admin approval status for reimbursement: pending, approved, rejected, paid.';
