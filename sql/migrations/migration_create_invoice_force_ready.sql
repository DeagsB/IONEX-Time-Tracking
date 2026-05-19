-- Per-batch override that promotes a pending (still-accumulating) invoice batch into the
-- Ready / Needs-Approval flows without waiting for its billing period to close. Admin
-- explicit action only — useful when the user knows no more tickets are coming for the
-- period (project complete, one-off invoice, etc.).

CREATE TABLE IF NOT EXISTS public.invoice_force_ready (
  group_id TEXT PRIMARY KEY,
  forced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  forced_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.invoice_force_ready IS
  'Admin override marking an otherwise-pending invoice batch as ready early. Keyed by the canonical groupId (resolvedPersistGroupId on the client). Removed when admin undoes the mark.';

ALTER TABLE public.invoice_force_ready ENABLE ROW LEVEL SECURITY;

-- Mirror invoiced_batch_marks: admins manage; helper is_admin() already exists in this DB.
DROP POLICY IF EXISTS "Admins manage invoice_force_ready" ON public.invoice_force_ready;
CREATE POLICY "Admins manage invoice_force_ready"
  ON public.invoice_force_ready
  FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());
