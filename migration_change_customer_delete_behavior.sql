-- Migration: Change customer deletion behavior
-- When a customer is deleted, set customer_id to NULL in associated projects instead of deleting the projects

-- First, drop the existing foreign key constraint
ALTER TABLE public.projects
DROP CONSTRAINT IF EXISTS projects_customer_id_fkey;

-- Recreate the foreign key constraint with SET NULL instead of CASCADE
ALTER TABLE public.projects
ADD CONSTRAINT projects_customer_id_fkey
FOREIGN KEY (customer_id)
REFERENCES public.customers(id)
ON DELETE SET NULL;

-- Add a comment to document this behavior
COMMENT ON COLUMN public.projects.customer_id IS 'Reference to the customer. When a customer is deleted, this is set to NULL and the project is preserved.';
