-- Migration: Add active flag to customers and projects
-- Instead of deleting, records are marked inactive and hidden from normal view.
-- Only admins can view and manage the inactive section.

-- Customers: add active column (default true for existing and new rows)
ALTER TABLE public.customers
ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

UPDATE public.customers SET active = true WHERE active IS NULL;
COMMENT ON COLUMN public.customers.active IS 'When false, customer is hidden from main list; only admins can see inactive customers.';

-- Projects: add active column (default true for existing and new rows)
ALTER TABLE public.projects
ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

UPDATE public.projects SET active = true WHERE active IS NULL;
COMMENT ON COLUMN public.projects.active IS 'When false, project is hidden from main list; only admins can see inactive projects.';
