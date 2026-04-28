-- Migration: Allow any authenticated user to update and delete customers and projects
-- (Previously only creator or admin could delete/update.)

-- Customers: allow any authenticated user to update and delete
DROP POLICY IF EXISTS "Users can update own customers" ON public.customers;
CREATE POLICY "Users can update customers" ON public.customers
  FOR UPDATE USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Users can delete own customers" ON public.customers;
CREATE POLICY "Users can delete customers" ON public.customers
  FOR DELETE USING (auth.uid() IS NOT NULL);

-- Projects: allow any authenticated user to update and delete
DROP POLICY IF EXISTS "Users can update own projects" ON public.projects;
CREATE POLICY "Users can update projects" ON public.projects
  FOR UPDATE USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Users can delete own projects" ON public.projects;
CREATE POLICY "Users can delete projects" ON public.projects
  FOR DELETE USING (auth.uid() IS NOT NULL);
