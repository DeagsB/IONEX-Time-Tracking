-- Migration: Add private projects and customers support
-- This allows users to create private projects/clients that are only visible to them

-- Add columns to customers table
ALTER TABLE public.customers
ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_created_by ON public.customers(created_by);
CREATE INDEX IF NOT EXISTS idx_customers_is_private ON public.customers(is_private);

COMMENT ON COLUMN public.customers.is_private IS 'When true, this customer is only visible to the user who created it';
COMMENT ON COLUMN public.customers.created_by IS 'User who created this customer. NULL means it was created before this feature or by an admin.';

-- Add columns to projects table
ALTER TABLE public.projects
ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_created_by ON public.projects(created_by);
CREATE INDEX IF NOT EXISTS idx_projects_is_private ON public.projects(is_private);

COMMENT ON COLUMN public.projects.is_private IS 'When true, this project is only visible to the user who created it';
COMMENT ON COLUMN public.projects.created_by IS 'User who created this project. NULL means it was created before this feature or by an admin.';

