-- Restrict service tickets so users can only read their own tickets.
-- Admins/Developers continue to see all via is_admin().
-- Fixes: Users were seeing everyone's service tickets.

DROP POLICY IF EXISTS "Users can read service tickets" ON public.service_tickets;
CREATE POLICY "Users can read own service tickets" ON public.service_tickets
  FOR SELECT
  USING (user_id = auth.uid() OR is_admin());

-- service_tickets_demo: restrict to own tickets for consistency
DROP POLICY IF EXISTS "Allow all operations on demo tickets" ON public.service_tickets_demo;
CREATE POLICY "Admins can manage all demo tickets" ON public.service_tickets_demo
  FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY "Users can manage own demo tickets" ON public.service_tickets_demo
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
