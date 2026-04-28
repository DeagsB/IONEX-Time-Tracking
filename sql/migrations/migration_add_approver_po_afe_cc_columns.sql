-- Add approver, po_afe, cc as separate columns to projects.
-- Keep approver_po_afe for backward compatibility during transition.
ALTER TABLE public.projects
ADD COLUMN IF NOT EXISTS approver TEXT,
ADD COLUMN IF NOT EXISTS po_afe TEXT,
ADD COLUMN IF NOT EXISTS cc TEXT;

COMMENT ON COLUMN public.projects.approver IS 'Approver code (e.g. G829, C566). Replaces approver_po_afe when migration complete.';
COMMENT ON COLUMN public.projects.po_afe IS 'PO/AFE value (e.g. FC250374-9084). Replaces approver_po_afe when migration complete.';
COMMENT ON COLUMN public.projects.cc IS 'CC value. New column.';

-- Backfill from approver_po_afe and other using simple heuristics
UPDATE public.projects
SET
  approver = COALESCE(
    NULLIF(TRIM(SUBSTRING(approver_po_afe FROM 'AC\s*[:\-]?\s*([^\s,;]+)')), ''),
    NULLIF(UPPER(SUBSTRING(approver_po_afe FROM 'G\d{3,}')), '')
  ),
  po_afe = COALESCE(
    NULLIF(TRIM(SUBSTRING(approver_po_afe FROM 'PO\s*[:\-]?\s*([A-Za-z0-9\-]+)')), ''),
    NULLIF(TRIM(SUBSTRING(approver_po_afe FROM '[A-Z]{2,}\d{4,}-\d{4,}')), '')
  ),
  cc = COALESCE(
    NULLIF(TRIM(SUBSTRING(approver_po_afe FROM 'CC\s*[:\-]?\s*([^\s,;]+)')), ''),
    NULLIF(TRIM(SUBSTRING(other FROM 'CC\s*[:\-]?\s*([^\s,;]+)')), '')
  )
WHERE approver_po_afe IS NOT NULL AND approver_po_afe != '';
