-- Migration: Add DEVELOPER role
-- Developers can switch between USER and ADMIN roles freely

-- Update the role check constraint to include DEVELOPER
ALTER TABLE public.users 
DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users 
ADD CONSTRAINT users_role_check 
CHECK (role IN ('ADMIN', 'USER', 'DEVELOPER'));

-- Add comment for documentation
COMMENT ON COLUMN public.users.role IS 'User role: ADMIN, USER, or DEVELOPER. Developers can switch between ADMIN/USER modes.';
