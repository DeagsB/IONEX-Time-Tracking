-- Migration: Performance optimizations based on Supabase advisor
-- Fixes: Unindexed foreign keys, RLS auth.uid() optimization, multiple policies consolidation

-- ============================================
-- 1. ADD INDEXES FOR FOREIGN KEYS
-- ============================================

-- Forms table foreign keys
CREATE INDEX IF NOT EXISTS idx_forms_employee_id ON public.forms(employee_id);
CREATE INDEX IF NOT EXISTS idx_forms_reviewed_by ON public.forms(reviewed_by);

-- Projects table foreign keys
CREATE INDEX IF NOT EXISTS idx_projects_customer_id ON public.projects(customer_id);

-- Service tickets foreign keys
CREATE INDEX IF NOT EXISTS idx_service_tickets_project_id ON public.service_tickets(project_id);

-- Time entries foreign keys
CREATE INDEX IF NOT EXISTS idx_time_entries_user_id ON public.time_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_employee_id ON public.time_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_project_id ON public.time_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_approved_by ON public.time_entries(approved_by);

-- ============================================
-- 2. OPTIMIZE RLS POLICIES - Use (select auth.uid()) instead of auth.uid()
-- This prevents re-evaluation for each row
-- ============================================

-- USERS TABLE
DROP POLICY IF EXISTS "Users can read own profile" ON public.users;
CREATE POLICY "Users can read own profile" ON public.users
  FOR SELECT
  USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Admins can read all users" ON public.users;
CREATE POLICY "Admins can read all users" ON public.users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Admins can update all users" ON public.users;
CREATE POLICY "Admins can update all users" ON public.users
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

-- CUSTOMERS TABLE
DROP POLICY IF EXISTS "Users can read accessible customers" ON public.customers;
CREATE POLICY "Users can read accessible customers" ON public.customers
  FOR SELECT
  USING (
    is_private = false 
    OR created_by = (select auth.uid())
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

DROP POLICY IF EXISTS "Users can update own customers" ON public.customers;
CREATE POLICY "Users can update own customers" ON public.customers
  FOR UPDATE
  USING (
    created_by = (select auth.uid())
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    created_by = (select auth.uid())
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

DROP POLICY IF EXISTS "Users can delete own customers" ON public.customers;
CREATE POLICY "Users can delete own customers" ON public.customers
  FOR DELETE
  USING (
    created_by = (select auth.uid())
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

-- PROJECTS TABLE
DROP POLICY IF EXISTS "Users can read accessible projects" ON public.projects;
CREATE POLICY "Users can read accessible projects" ON public.projects
  FOR SELECT
  USING (
    is_private = false 
    OR created_by = (select auth.uid())
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

DROP POLICY IF EXISTS "Users can update own projects" ON public.projects;
CREATE POLICY "Users can update own projects" ON public.projects
  FOR UPDATE
  USING (
    created_by = (select auth.uid())
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    created_by = (select auth.uid())
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

DROP POLICY IF EXISTS "Users can delete own projects" ON public.projects;
CREATE POLICY "Users can delete own projects" ON public.projects
  FOR DELETE
  USING (
    created_by = (select auth.uid())
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

-- EMPLOYEES TABLE
DROP POLICY IF EXISTS "Users can read own employee record" ON public.employees;
CREATE POLICY "Users can read own employee record" ON public.employees
  FOR SELECT
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Admins can read all employees" ON public.employees;
CREATE POLICY "Admins can read all employees" ON public.employees
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

DROP POLICY IF EXISTS "Admins can manage employees" ON public.employees;
CREATE POLICY "Admins can manage employees" ON public.employees
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

-- TIME_ENTRIES TABLE
DROP POLICY IF EXISTS "Users can manage own time entries" ON public.time_entries;
CREATE POLICY "Users can manage own time entries" ON public.time_entries
  FOR ALL
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Admins can manage all time entries" ON public.time_entries;
CREATE POLICY "Admins can manage all time entries" ON public.time_entries
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

-- FORMS TABLE
DROP POLICY IF EXISTS "Users can manage own forms" ON public.forms;
CREATE POLICY "Users can manage own forms" ON public.forms
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.employees
      WHERE id = employee_id AND user_id = (select auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.employees
      WHERE id = employee_id AND user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Admins can manage all forms" ON public.forms;
CREATE POLICY "Admins can manage all forms" ON public.forms
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

-- SERVICE_TICKETS TABLE
DROP POLICY IF EXISTS "Admins can manage service tickets" ON public.service_tickets;
CREATE POLICY "Admins can manage service tickets" ON public.service_tickets
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

-- SERVICE_TICKET_EXPENSES TABLE
DROP POLICY IF EXISTS "Admins can manage service ticket expenses" ON public.service_ticket_expenses;
CREATE POLICY "Admins can manage service ticket expenses" ON public.service_ticket_expenses
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = (select auth.uid()) AND role = 'ADMIN'
    )
  );

-- ============================================
-- 3. ENABLE RLS ON service_tickets_demo
-- ============================================
ALTER TABLE public.service_tickets_demo ENABLE ROW LEVEL SECURITY;

-- Allow all operations for demo table (since it's demo data)
CREATE POLICY "Allow all operations on demo tickets" ON public.service_tickets_demo
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 4. FIX FUNCTION SEARCH_PATH
-- ============================================
ALTER FUNCTION public.update_service_ticket_expenses_updated_at() SET search_path = public;
ALTER FUNCTION public.soft_delete_user(UUID) SET search_path = public;
ALTER FUNCTION public.archive_user(UUID) SET search_path = public;
ALTER FUNCTION public.unarchive_user(UUID) SET search_path = public;

