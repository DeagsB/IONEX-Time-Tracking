-- One-off: Remove duplicate service tickets for Morgan Wolfe created during location edits.
-- Run this in Supabase Dashboard → SQL Editor (use the project's SQL Editor).
-- Duplicates: same (date, user_id, customer_id); we keep one per group (prefer approved/ticket_number) and delete the rest.
-- Only the main table service_tickets is updated; service_tickets_demo is not touched.

-- PREVIEW (run this first to see duplicate groups and which tickets would be deleted):
-- WITH morgan AS (SELECT id AS user_id FROM public.users WHERE LOWER(TRIM(first_name)) = 'morgan' AND LOWER(TRIM(last_name)) = 'wolfe' LIMIT 1),
-- dup_groups AS (
--   SELECT date, user_id, customer_id, array_agg(id ORDER BY (ticket_number IS NOT NULL) DESC, id) AS ids, count(*) AS n
--   FROM public.service_tickets WHERE user_id = (SELECT user_id FROM morgan) GROUP BY date, user_id, customer_id HAVING count(*) > 1
-- )
-- SELECT d.date, d.customer_id, c.name AS customer_name, d.n AS ticket_count, d.ids AS ticket_ids_keep_first_delete_rest
-- FROM dup_groups d LEFT JOIN public.customers c ON c.id = d.customer_id ORDER BY d.date;

-- Step 1: Find Morgan Wolfe's user_id
DO $$
DECLARE
  morgan_user_id UUID;
  duplicate_ids UUID[];
  tid UUID;
  deleted_expenses INT;
  deleted_tickets INT;
BEGIN
  SELECT id INTO morgan_user_id
  FROM public.users
  WHERE LOWER(TRIM(first_name)) = 'morgan' AND LOWER(TRIM(last_name)) = 'wolfe'
  LIMIT 1;

  IF morgan_user_id IS NULL THEN
    RAISE NOTICE 'User "Morgan Wolfe" not found in users table. Check first_name/last_name.';
    RETURN;
  END IF;

  RAISE NOTICE 'Found user_id: %', morgan_user_id;

  -- Step 2: Collect ticket IDs to delete (duplicates: same date, user_id, customer_id; keep one per group)
  -- Keep the ticket with ticket_number if any, else the one with smallest id
  WITH dup_groups AS (
    SELECT date, user_id, customer_id,
           array_agg(id ORDER BY (ticket_number IS NOT NULL) DESC, id ASC) AS ids,
           count(*) AS cnt
    FROM public.service_tickets
    WHERE user_id = morgan_user_id
    GROUP BY date, user_id, customer_id
    HAVING count(*) > 1
  ),
  ids_to_delete AS (
    SELECT unnest(ids[2:array_length(ids, 1)]) AS id  -- all but first (kept)
    FROM dup_groups
  )
  SELECT array_agg(id) INTO duplicate_ids FROM ids_to_delete;

  IF duplicate_ids IS NULL OR array_length(duplicate_ids, 1) IS NULL THEN
    RAISE NOTICE 'No duplicate service tickets found for Morgan Wolfe.';
    RETURN;
  END IF;

  RAISE NOTICE 'Will delete % duplicate ticket(s)', array_length(duplicate_ids, 1);

  -- Step 3: Delete expenses for those tickets
  DELETE FROM public.service_ticket_expenses
  WHERE service_ticket_id = ANY(duplicate_ids);
  GET DIAGNOSTICS deleted_expenses = ROW_COUNT;
  RAISE NOTICE 'Deleted % expense row(s)', deleted_expenses;

  -- Step 4: Delete duplicate tickets
  DELETE FROM public.service_tickets
  WHERE id = ANY(duplicate_ids);
  GET DIAGNOSTICS deleted_tickets = ROW_COUNT;
  RAISE NOTICE 'Deleted % duplicate service ticket(s)', deleted_tickets;
END $$;
