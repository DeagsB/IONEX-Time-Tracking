-- Migration: Preserve data when user is deleted
-- This ensures that when a user is deleted, their time entries, employee records, and other data remain in the database
-- Run this in your Supabase SQL Editor

-- Step 1: Make time_entries.user_id nullable (currently NOT NULL)
-- This allows us to set it to NULL when user is deleted, preserving the time entry data
ALTER TABLE public.time_entries 
  ALTER COLUMN user_id DROP NOT NULL;

-- Step 2: Drop existing foreign key constraints that cascade delete
-- We'll recreate them with SET NULL to preserve data

-- Drop foreign key on employees table
ALTER TABLE public.employees 
  DROP CONSTRAINT IF EXISTS employees_user_id_fkey;

-- Drop foreign key on time_entries table  
ALTER TABLE public.time_entries 
  DROP CONSTRAINT IF EXISTS time_entries_user_id_fkey;

-- Drop foreign key on time_entries for approved_by (if it exists)
ALTER TABLE public.time_entries 
  DROP CONSTRAINT IF EXISTS time_entries_approved_by_fkey;

-- Drop foreign key on forms for reviewed_by (if it exists)
ALTER TABLE public.forms 
  DROP CONSTRAINT IF EXISTS forms_reviewed_by_fkey;

-- Step 3: Recreate foreign keys with SET NULL to preserve data
-- This allows the user_id to be set to NULL when the user is deleted, preserving the data

-- Employees: Set user_id to NULL when user is deleted (preserves employee record)
ALTER TABLE public.employees 
  ADD CONSTRAINT employees_user_id_fkey 
  FOREIGN KEY (user_id) 
  REFERENCES public.users(id) 
  ON DELETE SET NULL;

-- Time entries: Set user_id to NULL when user is deleted (preserves time entry data)
ALTER TABLE public.time_entries 
  ADD CONSTRAINT time_entries_user_id_fkey 
  FOREIGN KEY (user_id) 
  REFERENCES public.users(id) 
  ON DELETE SET NULL;

-- Time entries approved_by: Set to NULL when approver is deleted (preserves approval history)
ALTER TABLE public.time_entries 
  ADD CONSTRAINT time_entries_approved_by_fkey 
  FOREIGN KEY (approved_by) 
  REFERENCES public.users(id) 
  ON DELETE SET NULL;

-- Forms reviewed_by: Set to NULL when reviewer is deleted (preserves review history)
ALTER TABLE public.forms 
  ADD CONSTRAINT forms_reviewed_by_fkey 
  FOREIGN KEY (reviewed_by) 
  REFERENCES public.users(id) 
  ON DELETE SET NULL;

-- Step 3: Add a deleted_at column to users table for soft delete tracking (optional)
-- This allows you to mark users as deleted without actually removing them
ALTER TABLE public.users 
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- Create an index on deleted_at for efficient queries
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON public.users(deleted_at);

-- Step 4: Update RLS policies to exclude deleted users from normal queries
-- Users marked as deleted won't appear in normal SELECT queries
-- Admins can still see deleted users if needed

-- Note: The existing RLS policies will still work, but you may want to add:
-- WHERE deleted_at IS NULL to your policies if you want to hide deleted users

-- Step 5: Create a function to safely delete a user (soft delete)
-- This marks the user as deleted without removing their data
CREATE OR REPLACE FUNCTION public.soft_delete_user(user_uuid UUID)
RETURNS void AS $$
BEGIN
  -- Mark user as deleted
  UPDATE public.users 
  SET deleted_at = NOW() 
  WHERE id = user_uuid;
  
  -- Set user_id to NULL in related tables to preserve data
  UPDATE public.employees 
  SET user_id = NULL 
  WHERE user_id = user_uuid;
  
  -- Note: time_entries.user_id will be set to NULL automatically by the foreign key constraint
  -- Note: approved_by and reviewed_by will also be set to NULL automatically
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to authenticated users (admins only should use this)
GRANT EXECUTE ON FUNCTION public.soft_delete_user(UUID) TO authenticated;

-- Step 6: Add comment explaining the data preservation strategy
COMMENT ON CONSTRAINT employees_user_id_fkey ON public.employees IS 
  'Preserves employee record when user is deleted by setting user_id to NULL';

COMMENT ON CONSTRAINT time_entries_user_id_fkey ON public.time_entries IS 
  'Preserves time entry data when user is deleted by setting user_id to NULL';

COMMENT ON CONSTRAINT time_entries_approved_by_fkey ON public.time_entries IS 
  'Preserves approval record when approver is deleted by setting approved_by to NULL';

COMMENT ON CONSTRAINT forms_reviewed_by_fkey ON public.forms IS 
  'Preserves review record when reviewer is deleted by setting reviewed_by to NULL';

COMMENT ON COLUMN public.users.deleted_at IS 
  'Timestamp when user was soft deleted. NULL means user is active.';

