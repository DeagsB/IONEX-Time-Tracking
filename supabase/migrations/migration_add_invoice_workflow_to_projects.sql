-- Add invoice_workflow_id to projects so a project can override the customer's workflow.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS invoice_workflow_id UUID REFERENCES public.invoice_workflows(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.projects.invoice_workflow_id IS 'Optional reference to the invoice status workflow used for this project. Resolution order: project.invoice_workflow_id → customer.invoice_workflow_id → system default.';
