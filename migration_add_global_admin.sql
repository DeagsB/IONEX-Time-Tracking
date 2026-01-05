-- Migration: Add global_admin field to users table
-- This allows for a super-admin role that has access to payroll and user management

-- Add global_admin column
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS global_admin BOOLEAN DEFAULT false;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_users_global_admin ON public.users(global_admin);

-- Add comment
COMMENT ON COLUMN public.users.global_admin IS 'When true, user is a global admin with access to payroll and user management. Only one global admin should exist.';

-- Set deagan bespalko as global admin (by email)
UPDATE public.users
SET global_admin = true
WHERE email IN ('deagan.bespalko@ionexsystems.com', 'bespalkodeagan@gmail.com');

-- Update the role check constraint to allow GLOBAL_ADMIN (optional, if we want to use role instead)
-- For now, we'll use the global_admin boolean field

