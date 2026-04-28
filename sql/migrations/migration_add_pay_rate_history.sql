-- Migration: Add pay_rate_history table for historical rate tracking
-- Each row captures a snapshot of an employee's rates with an effective_date.
-- When calculating costs for a time entry, the rate effective on that date is used.

CREATE TABLE IF NOT EXISTS public.pay_rate_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  shop_pay_rate numeric(10,2) DEFAULT 0,
  field_pay_rate numeric(10,2) DEFAULT 0,
  shop_ot_pay_rate numeric(10,2) DEFAULT 0,
  field_ot_pay_rate numeric(10,2) DEFAULT 0,
  internal_rate numeric(10,2) DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(employee_id, effective_date)
);

-- Seed history from current employee rates so existing data has a baseline
INSERT INTO public.pay_rate_history (employee_id, effective_date, shop_pay_rate, field_pay_rate, shop_ot_pay_rate, field_ot_pay_rate, internal_rate)
SELECT
  id,
  CURRENT_DATE,
  COALESCE(shop_pay_rate, 0),
  COALESCE(field_pay_rate, 0),
  COALESCE(shop_ot_pay_rate, 0),
  COALESCE(field_ot_pay_rate, 0),
  COALESCE(internal_rate, 0)
FROM public.employees
ON CONFLICT (employee_id, effective_date) DO NOTHING;

-- RLS
ALTER TABLE public.pay_rate_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage pay_rate_history"
  ON public.pay_rate_history
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'global_admin'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'global_admin'))
  );

CREATE POLICY "Employees can view own pay_rate_history"
  ON public.pay_rate_history
  FOR SELECT
  USING (
    employee_id IN (
      SELECT id FROM public.employees WHERE user_id = auth.uid()
    )
  );
