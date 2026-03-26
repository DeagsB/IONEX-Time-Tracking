-- Allow users to add/edit/delete expenses for their own service tickets
-- (in addition to admins who can manage all expenses)

CREATE POLICY "Users can manage expenses for own service tickets" ON public.service_ticket_expenses
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.service_tickets st
      WHERE st.id = service_ticket_expenses.service_ticket_id
        AND st.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.service_tickets st
      WHERE st.id = service_ticket_expenses.service_ticket_id
        AND st.user_id = auth.uid()
    )
  );
