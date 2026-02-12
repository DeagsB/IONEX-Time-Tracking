-- Prevent header_overrides from being updated on approved/exported service tickets.
-- Once a ticket has ticket_number (admin approved), header_overrides must not change.
-- When approving (OLD.ticket_number IS NULL), allow the snapshot.

CREATE OR REPLACE FUNCTION protect_approved_ticket_header_overrides()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only protect when ticket was ALREADY approved (prevents sync/other updates from overwriting)
  IF OLD.ticket_number IS NOT NULL AND (TG_OP = 'UPDATE') THEN
    IF OLD.header_overrides IS NOT NULL AND OLD.header_overrides::text != '{}' AND OLD.header_overrides::text != 'null' THEN
      NEW.header_overrides := OLD.header_overrides;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_approved_ticket_header_overrides ON public.service_tickets;
CREATE TRIGGER protect_approved_ticket_header_overrides
  BEFORE UPDATE ON public.service_tickets
  FOR EACH ROW
  EXECUTE FUNCTION protect_approved_ticket_header_overrides();

DROP TRIGGER IF EXISTS protect_approved_ticket_header_overrides ON public.service_tickets_demo;
CREATE TRIGGER protect_approved_ticket_header_overrides
  BEFORE UPDATE ON public.service_tickets_demo
  FOR EACH ROW
  EXECUTE FUNCTION protect_approved_ticket_header_overrides();
