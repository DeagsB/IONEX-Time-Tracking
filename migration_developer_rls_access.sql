-- Migration: Grant DEVELOPER role the same RLS access as ADMIN
-- This allows developers to access all data when testing admin features
-- 
-- IMPORTANT: Uses is_admin() function with SECURITY DEFINER to avoid RLS recursion

-- Update is_admin function to include DEVELOPER role
-- Uses SECURITY DEFINER to bypass RLS during the check
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Update employees table policies
DROP POLICY IF EXISTS "Admins can manage employees" ON public.employees;
DROP POLICY IF EXISTS "Admins and Developers can manage employees" ON public.employees;
CREATE POLICY "Admins and Developers can manage employees" ON public.employees FOR ALL USING (is_admin());

DROP POLICY IF EXISTS "Users can read own employee record" ON public.employees;
CREATE POLICY "Users can read own employee record" ON public.employees FOR SELECT USING (
  user_id = auth.uid() OR is_admin()
);

-- Update customers table policies
DROP POLICY IF EXISTS "Admins can manage customers" ON public.customers;
DROP POLICY IF EXISTS "Admins and Developers can manage customers" ON public.customers;
CREATE POLICY "Admins and Developers can manage customers" ON public.customers FOR ALL USING (is_admin());

-- Update projects table policies
DROP POLICY IF EXISTS "Admins can manage projects" ON public.projects;
DROP POLICY IF EXISTS "Admins and Developers can manage projects" ON public.projects;
CREATE POLICY "Admins and Developers can manage projects" ON public.projects FOR ALL USING (is_admin());

-- Update time_entries table policies
DROP POLICY IF EXISTS "Admins can manage all time entries" ON public.time_entries;
DROP POLICY IF EXISTS "Admins and Developers can manage all time entries" ON public.time_entries;
CREATE POLICY "Admins and Developers can manage all time entries" ON public.time_entries FOR ALL USING (is_admin());

-- Update forms table policies
DROP POLICY IF EXISTS "Admins can manage all forms" ON public.forms;
DROP POLICY IF EXISTS "Admins and Developers can manage all forms" ON public.forms;
CREATE POLICY "Admins and Developers can manage all forms" ON public.forms FOR ALL USING (is_admin());

-- Update service_tickets table policies
DROP POLICY IF EXISTS "Admins can manage all service tickets" ON public.service_tickets;
DROP POLICY IF EXISTS "Admins and Developers can manage all service tickets" ON public.service_tickets;
CREATE POLICY "Admins and Developers can manage all service tickets" ON public.service_tickets FOR ALL USING (is_admin());

-- Update bug_reports table policies
DROP POLICY IF EXISTS "Admins can read all bug reports" ON public.bug_reports;
DROP POLICY IF EXISTS "Admins and Developers can read all bug reports" ON public.bug_reports;
CREATE POLICY "Admins and Developers can read all bug reports" ON public.bug_reports FOR SELECT USING (is_admin());

DROP POLICY IF EXISTS "Admins can update bug reports" ON public.bug_reports;
DROP POLICY IF EXISTS "Admins and Developers can update bug reports" ON public.bug_reports;
CREATE POLICY "Admins and Developers can update bug reports" ON public.bug_reports FOR UPDATE USING (is_admin());

DROP POLICY IF EXISTS "Admins can delete bug reports" ON public.bug_reports;
DROP POLICY IF EXISTS "Admins and Developers can delete bug reports" ON public.bug_reports;
CREATE POLICY "Admins and Developers can delete bug reports" ON public.bug_reports FOR DELETE USING (is_admin());
