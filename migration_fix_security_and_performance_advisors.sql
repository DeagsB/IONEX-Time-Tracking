-- Fix security and performance issues from Supabase advisors
-- Applied via Supabase MCP

-- ============================================
-- PERFORMANCE: Add missing foreign key indexes
-- ============================================

-- Index on bug_reports.resolved_by (foreign key to users)
CREATE INDEX IF NOT EXISTS idx_bug_reports_resolved_by ON public.bug_reports(resolved_by);

-- Index on time_entries.customer_id (foreign key to customers)
CREATE INDEX IF NOT EXISTS idx_time_entries_customer_id ON public.time_entries(customer_id);


-- ============================================
-- SECURITY: Fix function search_path
-- ============================================

-- Recreate is_admin function with fixed search_path
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role IN ('ADMIN', 'DEVELOPER')
  );
$$;

-- Recreate delete_user function with fixed search_path
CREATE OR REPLACE FUNCTION public.delete_user(user_uuid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete from auth.users (this will cascade to public.users)
  -- The employee record will be preserved with user_id set to NULL
  DELETE FROM auth.users WHERE id = user_uuid;
END;
$$;

-- Recreate handle_new_user function with fixed search_path
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_employee_id TEXT;
  user_department TEXT;
BEGIN
  -- Create user profile
  INSERT INTO public.users (id, email, first_name, last_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'last_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'USER')
  );
  
  -- Get department from user metadata
  user_department := NEW.raw_user_meta_data->>'department';
  
  -- Generate next employee ID
  new_employee_id := public.get_next_employee_id();
  
  -- Create employee record with auto-assigned ID and department
  INSERT INTO public.employees (
    user_id,
    employee_id,
    wage_rate,
    hire_date,
    status,
    department
  )
  VALUES (
    NEW.id,
    new_employee_id,
    25.00,
    CURRENT_DATE,
    'active',
    user_department
  );
  
  RETURN NEW;
END;
$$;


-- ============================================
-- SECURITY: Tighten RLS policies
-- ============================================

-- Drop and recreate bug_reports INSERT policy to require authenticated user
DROP POLICY IF EXISTS "Users can create bug reports" ON public.bug_reports;
CREATE POLICY "Users can create bug reports" ON public.bug_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- Drop and recreate customers INSERT policy to require authenticated user
DROP POLICY IF EXISTS "Users can create customers" ON public.customers;
CREATE POLICY "Users can create customers" ON public.customers
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- Drop and recreate projects INSERT policy to require authenticated user
DROP POLICY IF EXISTS "Users can create projects" ON public.projects;
CREATE POLICY "Users can create projects" ON public.projects
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- Note: service_tickets_demo is intentionally permissive for demo mode
