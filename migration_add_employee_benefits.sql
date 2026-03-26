-- Migration: Add employment type, benefit percentages, and flat allowances to employees
-- Distinguishes Employees (entitled to benefits, payroll tax) from Contractors (GST invoices)

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS employment_type TEXT DEFAULT 'Employee',
  ADD COLUMN IF NOT EXISTS sick_pay_pct DECIMAL(5, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stat_holiday_pay_pct DECIMAL(5, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vacation_pay_pct DECIMAL(5, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cell_phone_allowance DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS health_allowance DECIMAL(10, 2) DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE public.employees
    ADD CONSTRAINT employees_employment_type_check
    CHECK (employment_type IN ('Employee', 'Contractor'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.employees.employment_type IS 'Employee or Contractor. Contractors receive GST instead of benefits.';
COMMENT ON COLUMN public.employees.sick_pay_pct IS 'Sick pay percentage applied to all payroll hours (e.g. 1.54 = 1.54%).';
COMMENT ON COLUMN public.employees.stat_holiday_pay_pct IS 'Stat holiday pay percentage applied to all payroll hours.';
COMMENT ON COLUMN public.employees.vacation_pay_pct IS 'Vacation pay percentage applied to all payroll hours.';
COMMENT ON COLUMN public.employees.cell_phone_allowance IS 'Flat dollar amount for cell phone benefit per paycheque.';
COMMENT ON COLUMN public.employees.health_allowance IS 'Flat dollar amount for health benefit per paycheque.';
