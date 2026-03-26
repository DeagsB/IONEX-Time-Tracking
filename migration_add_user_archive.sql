-- Migration: Add archive functionality for users
-- This allows users to be archived (hidden) without deleting their data
-- Run this in your Supabase SQL Editor

-- Step 1: Add archived column to users table
ALTER TABLE public.users 
  ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false;

-- Step 2: Add archived_at timestamp for tracking when user was archived
ALTER TABLE public.users 
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;

-- Step 3: Create index for efficient queries filtering archived users
CREATE INDEX IF NOT EXISTS idx_users_archived ON public.users(archived);

-- Step 4: Add comment explaining the archive functionality
COMMENT ON COLUMN public.users.archived IS 
  'When true, user is archived and their data is hidden from normal views. Data is preserved but not shown in reports or application views.';

COMMENT ON COLUMN public.users.archived_at IS 
  'Timestamp when user was archived. NULL means user is active.';

-- Step 5: Create function to archive a user
CREATE OR REPLACE FUNCTION public.archive_user(user_uuid UUID)
RETURNS void AS $$
BEGIN
  UPDATE public.users 
  SET 
    archived = true,
    archived_at = NOW()
  WHERE id = user_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 6: Create function to unarchive a user
CREATE OR REPLACE FUNCTION public.unarchive_user(user_uuid UUID)
RETURNS void AS $$
BEGIN
  UPDATE public.users 
  SET 
    archived = false,
    archived_at = NULL
  WHERE id = user_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 7: Grant execute permissions
GRANT EXECUTE ON FUNCTION public.archive_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unarchive_user(UUID) TO authenticated;

