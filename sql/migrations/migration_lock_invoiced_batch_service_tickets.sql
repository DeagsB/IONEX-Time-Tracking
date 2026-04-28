-- Lock service tickets that appear in invoiced_batch_marks (snapshot ticketIds).
-- Blocks UPDATE/DELETE on service_tickets and mutations on linked expenses so billed amounts stay aligned.
-- Applies to all roles including admins; unmark the batch on Invoices to edit again.

CREATE OR REPLACE FUNCTION public.service_ticket_id_in_invoiced_batch(p_ticket_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.invoiced_batch_marks m
    CROSS JOIN LATERAL jsonb_array_elements_text(
      COALESCE(m.key_snapshot->'ticketIds', '[]'::jsonb)
    ) AS elem(tid)
    WHERE elem.tid = p_ticket_id::text
  );
$$;

COMMENT ON FUNCTION public.service_ticket_id_in_invoiced_batch(uuid) IS
  'True if this service_tickets.id is listed in any invoiced_batch_marks.key_snapshot.ticketIds.';

-- Employees: which of their tickets are in an invoiced batch (no cross-user data).
CREATE OR REPLACE FUNCTION public.locked_service_ticket_ids_for_current_user()
RETURNS TABLE(ticket_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT (elem.tid)::uuid AS ticket_id
  FROM public.invoiced_batch_marks m
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(m.key_snapshot->'ticketIds', '[]'::jsonb)
  ) AS elem(tid)
  INNER JOIN public.service_tickets st ON st.id::text = elem.tid
  WHERE st.user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.locked_service_ticket_ids_for_current_user() TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_invoiced_batch_service_ticket_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.service_ticket_id_in_invoiced_batch(OLD.id) THEN
      RAISE EXCEPTION 'Cannot delete: this service ticket is in a batch marked as invoiced. Unmark the batch on the Invoices page first.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND public.service_ticket_id_in_invoiced_batch(OLD.id) THEN
    RAISE EXCEPTION 'Cannot update: this service ticket is in a batch marked as invoiced. Unmark the batch on the Invoices page first.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_enforce_invoiced_batch_lock_service_tickets ON public.service_tickets;
CREATE TRIGGER a_enforce_invoiced_batch_lock_service_tickets
  BEFORE UPDATE OR DELETE ON public.service_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invoiced_batch_service_ticket_lock();

CREATE OR REPLACE FUNCTION public.enforce_invoiced_batch_ticket_expense_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tid uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    tid := NEW.service_ticket_id;
    IF tid IS NOT NULL AND public.service_ticket_id_in_invoiced_batch(tid) THEN
      RAISE EXCEPTION 'Cannot add expenses: service ticket is in an invoiced batch. Unmark on Invoices first.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    tid := OLD.service_ticket_id;
    IF tid IS NOT NULL AND public.service_ticket_id_in_invoiced_batch(tid) THEN
      RAISE EXCEPTION 'Cannot delete expense: service ticket is in an invoiced batch. Unmark on Invoices first.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE
  IF OLD.service_ticket_id IS NOT NULL AND public.service_ticket_id_in_invoiced_batch(OLD.service_ticket_id) THEN
    RAISE EXCEPTION 'Cannot update expense: service ticket is in an invoiced batch. Unmark on Invoices first.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.service_ticket_id IS NOT NULL
     AND NEW.service_ticket_id IS DISTINCT FROM OLD.service_ticket_id
     AND public.service_ticket_id_in_invoiced_batch(NEW.service_ticket_id) THEN
    RAISE EXCEPTION 'Cannot move expense onto a service ticket that is in an invoiced batch.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_enforce_invoiced_batch_lock_ticket_expenses ON public.service_ticket_expenses;
CREATE TRIGGER a_enforce_invoiced_batch_lock_ticket_expenses
  BEFORE INSERT OR UPDATE OR DELETE ON public.service_ticket_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invoiced_batch_ticket_expense_lock();

CREATE OR REPLACE FUNCTION public.enforce_invoiced_batch_user_expense_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tid uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    tid := NEW.service_ticket_id;
    IF tid IS NOT NULL AND public.service_ticket_id_in_invoiced_batch(tid) THEN
      RAISE EXCEPTION 'Cannot link expense: service ticket is in an invoiced batch. Unmark on Invoices first.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    tid := OLD.service_ticket_id;
    IF tid IS NOT NULL AND public.service_ticket_id_in_invoiced_batch(tid) THEN
      RAISE EXCEPTION 'Cannot delete or unlink expense: service ticket is in an invoiced batch. Unmark on Invoices first.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE
  IF OLD.service_ticket_id IS NOT NULL AND public.service_ticket_id_in_invoiced_batch(OLD.service_ticket_id) THEN
    RAISE EXCEPTION 'Cannot change expense linked to a service ticket in an invoiced batch. Unmark on Invoices first.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.service_ticket_id IS NOT NULL
     AND NEW.service_ticket_id IS DISTINCT FROM OLD.service_ticket_id
     AND public.service_ticket_id_in_invoiced_batch(NEW.service_ticket_id) THEN
    RAISE EXCEPTION 'Cannot link expense to a service ticket in an invoiced batch. Unmark on Invoices first.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_enforce_invoiced_batch_lock_user_expenses ON public.user_expenses;
CREATE TRIGGER a_enforce_invoiced_batch_lock_user_expenses
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invoiced_batch_user_expense_lock();
