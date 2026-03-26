-- Migration: Enable RLS on all tables with proper policies
-- This ensures data security at the database level

-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_ticket_expenses ENABLE ROW LEVEL SECURITY;

-- Drop existing problematic policies (if they exist)
DROP POLICY IF EXISTS "Allow unauthenticated admin operations on customers" ON public.customers;
DROP POLICY IF EXISTS "Allow unauthenticated admin operations on employees" ON public.employees;
DROP POLICY IF EXISTS "Allow unauthenticated admin operations on projects" ON public.projects;
DROP POLICY IF EXISTS "Allow unauthenticated admin operations on forms" ON public.forms;
DROP POLICY IF EXISTS "Allow unauthenticated read on users" ON public.users;

-- ============================================
-- USERS TABLE POLICIES
-- ============================================
-- Drop existing policies
DROP POLICY IF EXISTS "Users can read own profile" ON public.users;
DROP POLICY IF EXISTS "Admins can read all users" ON public.users;

-- Users can read their own profile
CREATE POLICY "Users can read own profile" ON public.users
  FOR SELECT
  USING (auth.uid() = id);

-- Admins can read all users
CREATE POLICY "Admins can read all users" ON public.users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Users can update their own profile
CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Admins can update all users
CREATE POLICY "Admins can update all users" ON public.users
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- ============================================
-- CUSTOMERS TABLE POLICIES
-- ============================================
-- Drop existing policies
DROP POLICY IF EXISTS "Admins can manage customers" ON public.customers;
DROP POLICY IF EXISTS "Users can read customers" ON public.customers;

-- Users can read public customers OR their own private customers
CREATE POLICY "Users can read accessible customers" ON public.customers
  FOR SELECT
  USING (
    is_private = false 
    OR created_by = auth.uid()
    OR created_by IS NULL  -- Legacy customers without created_by
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Users can create customers (will be set as created_by automatically)
CREATE POLICY "Users can create customers" ON public.customers
  FOR INSERT
  WITH CHECK (true);

-- Users can update their own customers OR admins can update any
CREATE POLICY "Users can update own customers" ON public.customers
  FOR UPDATE
  USING (
    created_by = auth.uid()
    OR created_by IS NULL  -- Legacy customers
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    created_by = auth.uid()
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Users can delete their own customers OR admins can delete any
CREATE POLICY "Users can delete own customers" ON public.customers
  FOR DELETE
  USING (
    created_by = auth.uid()
    OR created_by IS NULL  -- Legacy customers
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- ============================================
-- PROJECTS TABLE POLICIES
-- ============================================
-- Drop existing policies
DROP POLICY IF EXISTS "Admins can manage projects" ON public.projects;
DROP POLICY IF EXISTS "Users can read projects" ON public.projects;

-- Users can read public projects OR their own private projects
CREATE POLICY "Users can read accessible projects" ON public.projects
  FOR SELECT
  USING (
    is_private = false 
    OR created_by = auth.uid()
    OR created_by IS NULL  -- Legacy projects without created_by
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Users can create projects (will be set as created_by automatically)
CREATE POLICY "Users can create projects" ON public.projects
  FOR INSERT
  WITH CHECK (true);

-- Users can update their own projects OR admins can update any
CREATE POLICY "Users can update own projects" ON public.projects
  FOR UPDATE
  USING (
    created_by = auth.uid()
    OR created_by IS NULL  -- Legacy projects
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    created_by = auth.uid()
    OR created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Users can delete their own projects OR admins can delete any
CREATE POLICY "Users can delete own projects" ON public.projects
  FOR DELETE
  USING (
    created_by = auth.uid()
    OR created_by IS NULL  -- Legacy projects
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- ============================================
-- EMPLOYEES TABLE POLICIES
-- ============================================
-- Drop existing policies
DROP POLICY IF EXISTS "Admins can manage employees" ON public.employees;
DROP POLICY IF EXISTS "Users can read own employee record" ON public.employees;

-- Users can read their own employee record
CREATE POLICY "Users can read own employee record" ON public.employees
  FOR SELECT
  USING (user_id = auth.uid());

-- Admins can read all employees
CREATE POLICY "Admins can read all employees" ON public.employees
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Only admins can create/update/delete employees
CREATE POLICY "Admins can manage employees" ON public.employees
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- ============================================
-- TIME_ENTRIES TABLE POLICIES
-- ============================================
-- Drop existing policies (keep the good ones, just ensure they're correct)
-- Note: time_entries already has RLS enabled, just verify policies

-- Users can manage their own time entries
DROP POLICY IF EXISTS "Users can manage own time entries" ON public.time_entries;
CREATE POLICY "Users can manage own time entries" ON public.time_entries
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Admins can manage all time entries
DROP POLICY IF EXISTS "Admins can manage all time entries" ON public.time_entries;
CREATE POLICY "Admins can manage all time entries" ON public.time_entries
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- ============================================
-- FORMS TABLE POLICIES
-- ============================================
-- Drop existing policies
DROP POLICY IF EXISTS "Users can manage own forms" ON public.forms;
DROP POLICY IF EXISTS "Admins can manage all forms" ON public.forms;

-- Users can manage forms for their employee record
CREATE POLICY "Users can manage own forms" ON public.forms
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.employees
      WHERE id = employee_id AND user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.employees
      WHERE id = employee_id AND user_id = auth.uid()
    )
  );

-- Admins can manage all forms
CREATE POLICY "Admins can manage all forms" ON public.forms
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- ============================================
-- SERVICE_TICKETS TABLE POLICIES
-- ============================================
-- Users can read all service tickets (for now, can be restricted later)
CREATE POLICY "Users can read service tickets" ON public.service_tickets
  FOR SELECT
  USING (true);

-- Only admins can create/update/delete service tickets
CREATE POLICY "Admins can manage service tickets" ON public.service_tickets
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- ============================================
-- SERVICE_TICKET_EXPENSES TABLE POLICIES
-- ============================================
-- Users can read expenses for tickets they can see
CREATE POLICY "Users can read service ticket expenses" ON public.service_ticket_expenses
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.service_tickets
      WHERE id = service_ticket_expenses.service_ticket_id
    )
  );

-- Only admins can create/update/delete expenses
CREATE POLICY "Admins can manage service ticket expenses" ON public.service_ticket_expenses
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

