-- Allow regular users to create and update their own service tickets for Submit for Approval
-- (Admins/Developers can already manage all via is_admin(); this adds permission for USER role)
-- Fix: Morgan Wolfe (USER role) could not submit; only Deagan Bespalko (DEVELOPER role) could.
CREATE POLICY "Users can insert and update own service tickets" ON public.service_tickets
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own service tickets" ON public.service_tickets
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
