-- Migration: Fix users table RLS policies to avoid recursion
-- The issue was that "Admins can read all users" policy tried to query users table
-- from within users RLS policy, causing infinite recursion and 500 errors

-- Drop existing problematic policies
DROP POLICY IF EXISTS "Users can read own profile" ON public.users;
DROP POLICY IF EXISTS "Admins can read all users" ON public.users;
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
DROP POLICY IF EXISTS "Admins can update all users" ON public.users;

-- Create a helper function to check if current user is admin
-- SECURITY DEFINER allows it to bypass RLS, preventing recursion
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'ADMIN'
  );
$$;

-- Combine read policies into one (prevents multiple permissive policies)
CREATE POLICY "Users can read own profile or admins can read all" ON public.users
  FOR SELECT
  USING (
    id = (select auth.uid())
    OR (select public.is_admin())
  );

-- Combine update policies into one
CREATE POLICY "Users can update own profile or admins can update all" ON public.users
  FOR UPDATE
  USING (
    id = (select auth.uid())
    OR (select public.is_admin())
  )
  WITH CHECK (
    id = (select auth.uid())
    OR (select public.is_admin())
  );

