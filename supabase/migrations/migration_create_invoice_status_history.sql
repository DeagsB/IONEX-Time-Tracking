CREATE TABLE public.invoice_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL,
  customer_name TEXT,
  project_number TEXT,
  workflow_id UUID REFERENCES public.invoice_workflows(id) ON DELETE SET NULL,
  status_id TEXT NOT NULL,
  status_label TEXT NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at TIMESTAMPTZ,
  days_in_status NUMERIC(10,2),
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.invoice_status_history IS 'Logs every status transition for invoiced batches. Used for historical trend analysis (avg time in each status per customer/project).';

CREATE INDEX idx_invoice_status_history_group_id ON public.invoice_status_history(group_id);
CREATE INDEX idx_invoice_status_history_customer ON public.invoice_status_history(customer_name);
CREATE INDEX idx_invoice_status_history_status ON public.invoice_status_history(status_id);

ALTER TABLE public.invoice_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read invoice_status_history" ON public.invoice_status_history
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert invoice_status_history" ON public.invoice_status_history
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update invoice_status_history" ON public.invoice_status_history
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
