-- Optional per-project default for Invoices date grouping. NULL = legacy behavior (customer default on Invoices page).
-- New projects are set to bi-weekly in the app on create; existing rows stay NULL.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS invoice_date_grouping TEXT;

COMMENT ON COLUMN public.projects.invoice_date_grouping IS
  'Invoices page grouping: daily | weekly | bi-weekly | monthly | project-completion. NULL = use customer-level default.';
