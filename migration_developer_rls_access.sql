-- Migration: Grant DEVELOPER role the same RLS access as ADMIN
-- This allows developers to access all data when testing admin features

-- Update users table policies
DROP POLICY IF EXISTS "Admins can read all users" ON public.users;
CREATE POLICY "Admins and Developers can read all users" ON public.users FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

-- Update customers table policies
DROP POLICY IF EXISTS "Admins can manage customers" ON public.customers;
CREATE POLICY "Admins and Developers can manage customers" ON public.customers FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

-- Update projects table policies
DROP POLICY IF EXISTS "Admins can manage projects" ON public.projects;
CREATE POLICY "Admins and Developers can manage projects" ON public.projects FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

-- Update employees table policies
DROP POLICY IF EXISTS "Admins can manage employees" ON public.employees;
CREATE POLICY "Admins and Developers can manage employees" ON public.employees FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

-- Also allow developers to read ALL employee records (not just their own)
DROP POLICY IF EXISTS "Users can read own employee record" ON public.employees;
CREATE POLICY "Users can read own employee record" ON public.employees FOR SELECT USING (
  user_id = auth.uid() OR 
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

-- Update time_entries table policies
DROP POLICY IF EXISTS "Admins can manage all time entries" ON public.time_entries;
CREATE POLICY "Admins and Developers can manage all time entries" ON public.time_entries FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

-- Update forms table policies
DROP POLICY IF EXISTS "Admins can manage all forms" ON public.forms;
CREATE POLICY "Admins and Developers can manage all forms" ON public.forms FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

-- Update service_tickets table policies if they exist
DROP POLICY IF EXISTS "Admins can manage all service tickets" ON public.service_tickets;
CREATE POLICY "Admins and Developers can manage all service tickets" ON public.service_tickets FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

-- Update bug_reports table policies if they exist
DROP POLICY IF EXISTS "Admins can read all bug reports" ON public.bug_reports;
CREATE POLICY "Admins and Developers can read all bug reports" ON public.bug_reports FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

DROP POLICY IF EXISTS "Admins can update bug reports" ON public.bug_reports;
CREATE POLICY "Admins and Developers can update bug reports" ON public.bug_reports FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);

DROP POLICY IF EXISTS "Admins can delete bug reports" ON public.bug_reports;
CREATE POLICY "Admins and Developers can delete bug reports" ON public.bug_reports FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER'))
);
