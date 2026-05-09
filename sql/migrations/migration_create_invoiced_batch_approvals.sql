-- Stores the signed/approved batch PDF uploaded after a customer approves a batch
-- (Portal Approval workflow). Mirrors invoiced_batch_invoices: same group_id key,
-- separate row per batch. Files live in the same Supabase Storage bucket
-- (invoiced-batch-invoices) under an _approvals/ prefix.
CREATE TABLE IF NOT EXISTS public.invoiced_batch_approvals (
  group_id TEXT PRIMARY KEY,
  approval_filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by UUID REFERENCES public.users (id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoiced_batch_approvals_uploaded_at
  ON public.invoiced_batch_approvals (uploaded_at DESC);

COMMENT ON TABLE public.invoiced_batch_approvals IS
  'Signed/approved batch PDFs uploaded once a customer approves a batch (Portal Approval workflow). Same group_id key as invoiced_batch_marks / invoiced_batch_invoices.';

ALTER TABLE public.invoiced_batch_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage invoiced_batch_approvals"
  ON public.invoiced_batch_approvals
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
