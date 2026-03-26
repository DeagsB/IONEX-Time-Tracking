-- Persist "marked as invoiced" batch state in the database (authoritative source).
-- Complements invoiced_batch_invoices (linked PDFs): a batch can be marked without a PDF.
CREATE TABLE IF NOT EXISTS public.invoiced_batch_marks (
  group_id TEXT PRIMARY KEY,
  key_snapshot JSONB NOT NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  marked_by UUID REFERENCES public.users (id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoiced_batch_marks_marked_at ON public.invoiced_batch_marks (marked_at DESC);

COMMENT ON TABLE public.invoiced_batch_marks IS
  'Invoice page: groups marked as invoiced (same group_id as invoiced_batch_invoices / getGroupId).';

ALTER TABLE public.invoiced_batch_marks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage invoiced_batch_marks"
  ON public.invoiced_batch_marks
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
