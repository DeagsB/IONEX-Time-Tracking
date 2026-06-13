-- Per-project, human-readable Summary Number for each invoice batch (Service Ticket Summary).
-- The client references ONE id (e.g. 26012-007) for cost tracking instead of every ticket number
-- under the batch. Allocated at summary-PDF generation time (the PDF is built before the
-- invoiced_batch_marks row exists), keyed by the resolved persist group_id, and idempotent so
-- re-downloads of the same batch reuse the same number.

-- Per-project running counter. Keyed by the project id string carried on the invoice group key
-- (TEXT, not UUID — standalone/legacy group keys are not guaranteed to be clean UUIDs).
CREATE TABLE IF NOT EXISTS public.invoice_summary_counters (
  project_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.invoice_summary_counters IS
  'Per-project counter backing the batch Summary Number (allocate_batch_summary_no). last_seq is the highest sequence handed out for the project.';

-- One allocated Summary Number per batch. group_id is the resolvedPersistGroupId on the client.
CREATE TABLE IF NOT EXISTS public.invoice_batch_summary_nos (
  group_id TEXT PRIMARY KEY,
  project_id TEXT,
  summary_no TEXT NOT NULL UNIQUE,
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  allocated_by UUID REFERENCES public.users (id) ON DELETE SET NULL
);

COMMENT ON TABLE public.invoice_batch_summary_nos IS
  'Frozen Summary Number per invoice batch (Service Ticket Summary cover). Keyed by resolvedPersistGroupId / getGroupId.';

ALTER TABLE public.invoice_summary_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_batch_summary_nos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage invoice_summary_counters" ON public.invoice_summary_counters;
CREATE POLICY "Admins manage invoice_summary_counters"
  ON public.invoice_summary_counters
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage invoice_batch_summary_nos" ON public.invoice_batch_summary_nos;
CREATE POLICY "Admins manage invoice_batch_summary_nos"
  ON public.invoice_batch_summary_nos
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Idempotent, atomic allocation. Returns the existing number if this batch already has one;
-- otherwise bumps the per-project counter and formats {projectNumber}-{NNN} (e.g. 26012-007).
-- Falls back to the project id when no project number is supplied. SECURITY DEFINER so the
-- counter bump + insert run as one privileged unit; callers are still gated by is_admin() via
-- the EXECUTE grant + the table policies above.
CREATE OR REPLACE FUNCTION public.allocate_batch_summary_no(
  p_group_id TEXT,
  p_project_id TEXT,
  p_project_number TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing TEXT;
  v_seq INTEGER;
  v_prefix TEXT;
  v_result TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT summary_no INTO v_existing
  FROM public.invoice_batch_summary_nos
  WHERE group_id = p_group_id;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  INSERT INTO public.invoice_summary_counters (project_id, last_seq)
  VALUES (COALESCE(NULLIF(TRIM(p_project_id), ''), '_'), 1)
  ON CONFLICT (project_id)
  DO UPDATE SET last_seq = public.invoice_summary_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  v_prefix := COALESCE(NULLIF(TRIM(p_project_number), ''), NULLIF(TRIM(p_project_id), ''), 'BATCH');
  v_result := v_prefix || '-' || LPAD(v_seq::TEXT, 3, '0');

  INSERT INTO public.invoice_batch_summary_nos (group_id, project_id, summary_no, allocated_by)
  VALUES (p_group_id, COALESCE(NULLIF(TRIM(p_project_id), ''), '_'), v_result, auth.uid());

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.allocate_batch_summary_no(TEXT, TEXT, TEXT) TO authenticated;
