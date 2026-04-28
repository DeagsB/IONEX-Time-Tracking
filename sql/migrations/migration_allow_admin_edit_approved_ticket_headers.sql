-- Allow admins to edit header_overrides on approved service tickets.
-- The protect_approved_ticket_header_overrides trigger currently blocks ALL updates
-- to header_overrides on approved tickets, preventing admin edits from being saved.
-- This migration updates the trigger to allow admins (is_admin()) to update headers,
-- while still protecting against non-admin overwrites (e.g. sync, other updates).

CREATE OR REPLACE FUNCTION protect_approved_ticket_header_overrides()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only protect when ticket was ALREADY approved (prevents sync/other updates from overwriting)
  -- Admins can always edit header_overrides on approved tickets
  IF OLD.ticket_number IS NOT NULL AND (TG_OP = 'UPDATE') THEN
    IF is_admin() THEN
      -- Admin: allow the update (do nothing, NEW.header_overrides stays as-is)
      NULL;
    ELSIF OLD.header_overrides IS NOT NULL AND OLD.header_overrides::text != '{}' AND OLD.header_overrides::text != 'null' THEN
      -- Non-admin: protect existing header_overrides
      NEW.header_overrides := OLD.header_overrides;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
