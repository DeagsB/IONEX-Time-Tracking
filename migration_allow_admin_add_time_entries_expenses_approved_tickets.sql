-- Allow admins to add time entries (service rows) and expenses to approved service tickets.
-- 1. Add trigger to protect edited_descriptions/edited_hours on approved tickets from non-admin updates,
--    while allowing admins to add/edit service rows (same pattern as header_overrides).
-- 2. Update service_ticket_expenses policy to use is_admin() so DEVELOPER role can also add expenses.

-- 1. Protect edited_descriptions and edited_hours on approved tickets from non-admin overwrites
--    Admins can always update (add rows, edit hours)
CREATE OR REPLACE FUNCTION protect_approved_ticket_edited_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.ticket_number IS NOT NULL AND (TG_OP = 'UPDATE') THEN
    IF is_admin() THEN
      -- Admin: allow the update (add rows, edit hours, etc.)
      NULL;
    ELSE
      -- Non-admin: protect edited_descriptions and edited_hours
      NEW.edited_descriptions := OLD.edited_descriptions;
      NEW.edited_hours := OLD.edited_hours;
      NEW.is_edited := OLD.is_edited;
      NEW.total_hours := OLD.total_hours;
      NEW.total_amount := OLD.total_amount;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_approved_ticket_edited_data ON public.service_tickets;
CREATE TRIGGER protect_approved_ticket_edited_data
  BEFORE UPDATE ON public.service_tickets
  FOR EACH ROW
  EXECUTE FUNCTION protect_approved_ticket_edited_data();

DROP TRIGGER IF EXISTS protect_approved_ticket_edited_data ON public.service_tickets_demo;
CREATE TRIGGER protect_approved_ticket_edited_data
  BEFORE UPDATE ON public.service_tickets_demo
  FOR EACH ROW
  EXECUTE FUNCTION protect_approved_ticket_edited_data();

-- 2. Update service_ticket_expenses policy to use is_admin() (ADMIN + DEVELOPER)
DROP POLICY IF EXISTS "Admins can manage service ticket expenses" ON public.service_ticket_expenses;
CREATE POLICY "Admins and Developers can manage service ticket expenses" ON public.service_ticket_expenses
  FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());
