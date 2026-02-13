-- Update column comments to reflect new display titles:
-- PO/AFE -> PO/AFE/CC (Cost Center)
-- CC -> Coding

COMMENT ON COLUMN public.projects.po_afe IS 'PO/AFE/CC (Cost Center) value (e.g. FC250374-9084). Replaces approver_po_afe when migration complete.';
COMMENT ON COLUMN public.projects.cc IS 'Coding value. New column.';

COMMENT ON COLUMN public.time_entries.po_afe IS 'PO/AFE/CC (Cost Center) field - auto-populated from project, editable by user on time entry form';
COMMENT ON COLUMN public.time_entries.cc IS 'Coding value. Extracted from po_afe during migration.';
