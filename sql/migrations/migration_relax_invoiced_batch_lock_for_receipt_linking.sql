-- Migration: Allow linking a receipt (user_expense_id) and updating actual_cost
-- on a ticket expense even when the underlying service ticket is in an invoiced
-- batch.
--
-- Rationale: The customer invoice freezes billed amounts (quantity, rate,
-- description, amount, gst). user_expense_id and actual_cost are *internal*
-- cost-tracking fields that never appear on the customer's invoice — they only
-- affect profitability/payroll reporting. Forcing admins to unmark/remark the
-- batch every time they attach a historical receipt is friction without value.
--
-- This supersedes the previous payroll-status relaxation by extending the
-- allow-list. It also keeps the same hard locks on customer-facing fields
-- (expense_type, description, quantity, rate, unit, amount, gst, needs_reimbursement,
-- service_ticket_id).

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
    -- Allow updates that only touch internal cost-tracking / payroll fields.
    -- Customer-facing billed fields (expense_type, description, quantity, rate,
    -- unit, needs_reimbursement) and the ticket assignment stay locked.
    -- Released for editing under invoiced lock:
    --   reimbursement_status, reimbursement_approved_at  (payroll-side)
    --   user_expense_id                                  (receipt link, internal)
    --   actual_cost                                      (cost basis, internal)
    IF NEW.expense_type IS NOT DISTINCT FROM OLD.expense_type
       AND NEW.description IS NOT DISTINCT FROM OLD.description
       AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
       AND NEW.rate IS NOT DISTINCT FROM OLD.rate
       AND NEW.unit IS NOT DISTINCT FROM OLD.unit
       AND NEW.needs_reimbursement IS NOT DISTINCT FROM OLD.needs_reimbursement
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
