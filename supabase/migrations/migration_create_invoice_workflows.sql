-- Invoice status workflows table
CREATE TABLE public.invoice_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  statuses JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invoice_workflows IS 'Defines reusable invoice status workflows (ordered sets of statuses) that can be assigned to customers.';
COMMENT ON COLUMN public.invoice_workflows.statuses IS 'JSONB array of status objects: [{"id": "uuid", "label": "string", "color": "string"}] in display order.';

-- Enable RLS
ALTER TABLE public.invoice_workflows ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read workflows
CREATE POLICY "Authenticated users can read invoice_workflows" ON public.invoice_workflows
  FOR SELECT TO authenticated USING (true);

-- Only admins can modify workflows
CREATE POLICY "Admins can insert invoice_workflows" ON public.invoice_workflows
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Admins can update invoice_workflows" ON public.invoice_workflows
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Admins can delete invoice_workflows" ON public.invoice_workflows
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

-- Add invoice_workflow_id to customers
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS invoice_workflow_id UUID REFERENCES public.invoice_workflows(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.customers.invoice_workflow_id IS 'Optional reference to the invoice status workflow used for this customer. Falls back to the system default workflow if null.';

-- Seed two default workflows
INSERT INTO public.invoice_workflows (name, statuses, is_default) VALUES
  ('Standard', '[{"id": "draft", "label": "Draft", "color": "gray"}, {"id": "sent", "label": "Sent to Customer", "color": "green"}]'::jsonb, true),
  ('Portal Approval', '[{"id": "draft", "label": "Draft", "color": "gray"}, {"id": "submitted_approval", "label": "Submitted for Approval", "color": "orange"}, {"id": "approved", "label": "Approved", "color": "blue"}, {"id": "submitted_portal", "label": "Submitted to Portal", "color": "green"}]'::jsonb, false);
