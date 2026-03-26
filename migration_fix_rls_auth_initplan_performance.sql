-- Fix auth_rls_initplan performance issues
-- Change auth.uid() to (SELECT auth.uid()) for query optimization
-- Applied via Supabase MCP

-- ============================================
-- bug_reports
-- ============================================
DROP POLICY IF EXISTS "Users can create bug reports" ON public.bug_reports;
CREATE POLICY "Users can create bug reports" ON public.bug_reports
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

-- ============================================
-- customer_user_assignments
-- ============================================
DROP POLICY IF EXISTS "Admins can create assignments" ON public.customer_user_assignments;
CREATE POLICY "Admins can create assignments" ON public.customer_user_assignments
  FOR INSERT TO public
  WITH CHECK (EXISTS (SELECT 1 FROM users WHERE users.id = (SELECT auth.uid()) AND users.role = 'ADMIN'));

DROP POLICY IF EXISTS "Admins can delete assignments" ON public.customer_user_assignments;
CREATE POLICY "Admins can delete assignments" ON public.customer_user_assignments
  FOR DELETE TO public
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = (SELECT auth.uid()) AND users.role = 'ADMIN'));

DROP POLICY IF EXISTS "Admins can update assignments" ON public.customer_user_assignments;
CREATE POLICY "Admins can update assignments" ON public.customer_user_assignments
  FOR UPDATE TO public
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = (SELECT auth.uid()) AND users.role = 'ADMIN'));

DROP POLICY IF EXISTS "Admins can view all assignments" ON public.customer_user_assignments;
CREATE POLICY "Admins can view all assignments" ON public.customer_user_assignments
  FOR SELECT TO public
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = (SELECT auth.uid()) AND users.role = 'ADMIN'));

DROP POLICY IF EXISTS "Users can view own assignments" ON public.customer_user_assignments;
CREATE POLICY "Users can view own assignments" ON public.customer_user_assignments
  FOR SELECT TO public
  USING (user_id = (SELECT auth.uid()));

-- ============================================
-- customers
-- ============================================
DROP POLICY IF EXISTS "Users can create customers" ON public.customers;
CREATE POLICY "Users can create customers" ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Users can delete customers" ON public.customers;
CREATE POLICY "Users can delete customers" ON public.customers
  FOR DELETE TO public
  USING ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Users can update customers" ON public.customers;
CREATE POLICY "Users can update customers" ON public.customers
  FOR UPDATE TO public
  USING ((SELECT auth.uid()) IS NOT NULL)
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

-- ============================================
-- employees
-- ============================================
DROP POLICY IF EXISTS "Users can read own employee record" ON public.employees;
CREATE POLICY "Users can read own employee record" ON public.employees
  FOR SELECT TO public
  USING (user_id = (SELECT auth.uid()) OR is_admin());

-- ============================================
-- project_user_assignments
-- ============================================
DROP POLICY IF EXISTS "Admins can create assignments" ON public.project_user_assignments;
CREATE POLICY "Admins can create assignments" ON public.project_user_assignments
  FOR INSERT TO public
  WITH CHECK (EXISTS (SELECT 1 FROM users WHERE users.id = (SELECT auth.uid()) AND users.role = 'ADMIN'));

DROP POLICY IF EXISTS "Admins can delete assignments" ON public.project_user_assignments;
CREATE POLICY "Admins can delete assignments" ON public.project_user_assignments
  FOR DELETE TO public
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = (SELECT auth.uid()) AND users.role = 'ADMIN'));

DROP POLICY IF EXISTS "Admins can update assignments" ON public.project_user_assignments;
CREATE POLICY "Admins can update assignments" ON public.project_user_assignments
  FOR UPDATE TO public
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = (SELECT auth.uid()) AND users.role = 'ADMIN'));

DROP POLICY IF EXISTS "Admins can view all assignments" ON public.project_user_assignments;
CREATE POLICY "Admins can view all assignments" ON public.project_user_assignments
  FOR SELECT TO public
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = (SELECT auth.uid()) AND users.role = 'ADMIN'));

DROP POLICY IF EXISTS "Users can view own assignments" ON public.project_user_assignments;
CREATE POLICY "Users can view own assignments" ON public.project_user_assignments
  FOR SELECT TO public
  USING (user_id = (SELECT auth.uid()));

-- ============================================
-- projects
-- ============================================
DROP POLICY IF EXISTS "Users can create projects" ON public.projects;
CREATE POLICY "Users can create projects" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Users can delete projects" ON public.projects;
CREATE POLICY "Users can delete projects" ON public.projects
  FOR DELETE TO public
  USING ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Users can update projects" ON public.projects;
CREATE POLICY "Users can update projects" ON public.projects
  FOR UPDATE TO public
  USING ((SELECT auth.uid()) IS NOT NULL)
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

-- ============================================
-- qbo_tokens
-- ============================================
DROP POLICY IF EXISTS "Service role only" ON public.qbo_tokens;
CREATE POLICY "Service role only" ON public.qbo_tokens
  FOR ALL TO public
  USING ((SELECT auth.role()) = 'service_role');

-- ============================================
-- service_ticket_expenses
-- ============================================
DROP POLICY IF EXISTS "Users can manage expenses for own service tickets" ON public.service_ticket_expenses;
CREATE POLICY "Users can manage expenses for own service tickets" ON public.service_ticket_expenses
  FOR ALL TO public
  USING (EXISTS (SELECT 1 FROM service_tickets st WHERE st.id = service_ticket_expenses.service_ticket_id AND st.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM service_tickets st WHERE st.id = service_ticket_expenses.service_ticket_id AND st.user_id = (SELECT auth.uid())));

-- ============================================
-- service_tickets
-- ============================================
DROP POLICY IF EXISTS "Users can insert and update own service tickets" ON public.service_tickets;
CREATE POLICY "Users can insert and update own service tickets" ON public.service_tickets
  FOR INSERT TO public
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update own service tickets" ON public.service_tickets;
CREATE POLICY "Users can update own service tickets" ON public.service_tickets
  FOR UPDATE TO public
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
