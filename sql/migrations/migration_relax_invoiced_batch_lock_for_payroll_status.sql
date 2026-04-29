-- Migration: Relax the invoiced-batch update lock so admins can mark
-- reimbursement_status (ticket expenses) and status (receipt expenses) as paid
-- even when the underlying service ticket is in an invoiced batch.
--
-- Rationale: invoicing freezes the *billed* amounts (rate, qty, description,
-- amount, gst) so the customer's invoice stays aligned with the records. But
-- reimbursement_status / status are payroll-side fields with no impact on the
-- customer invoice. Blocking those forced admins to unmark/remark batches
-- every payroll cycle, which is friction without value.

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
    -- Allow updates that only touch payroll-side fields (reimbursement_status,
    -- reimbursement_approved_at). Customer-facing fields stay locked.
    IF NEW.expense_type IS NOT DISTINCT FROM OLD.expense_type
       AND NEW.description IS NOT DISTINCT FROM OLD.description
       AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
       AND NEW.rate IS NOT DISTINCT FROM OLD.rate
       AND NEW.unit IS NOT DISTINCT FROM OLD.unit
       AND NEW.actual_cost IS NOT DISTINCT FROM OLD.actual_cost
       AND NEW.needs_reimbursement IS NOT DISTINCT FROM OLD.needs_reimbursement
       AND NEW.user_expense_id IS NOT DISTINCT FROM OLD.user_expense_id
       AND NEW.service_ticket_id IS NOT DISTINCT FROM OLD.service_ticket_id THEN
      RETURN NEW;
    END IF;
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
    -- Allow updates that only touch payroll-side fields (status, approved_at, notes).
    -- Anything that affects the billed amount or which ticket the receipt belongs to stays locked.
    IF NEW.amount IS NOT DISTINCT FROM OLD.amount
       AND NEW.gst IS NOT DISTINCT FROM OLD.gst
       AND NEW.markup_amount IS NOT DISTINCT FROM OLD.markup_amount
       AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
       AND NEW.is_billable IS NOT DISTINCT FROM OLD.is_billable
       AND NEW.description IS NOT DISTINCT FROM OLD.description
       AND NEW.expense_date IS NOT DISTINCT FROM OLD.expense_date
       AND NEW.service_ticket_id IS NOT DISTINCT FROM OLD.service_ticket_id
       AND NEW.receipt_url IS NOT DISTINCT FROM OLD.receipt_url THEN
      RETURN NEW;
    END IF;
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
