-- Mark projects as closed for Profitability styling (separate from status string and active flag).

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS is_completed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.projects.is_completed IS 'When true, work is closed; Profitability greys out the row. Toggle from Projects page.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'projects_demo'
  ) THEN
    ALTER TABLE public.projects_demo
      ADD COLUMN IF NOT EXISTS is_completed boolean NOT NULL DEFAULT false;
  END IF;
END $$;
