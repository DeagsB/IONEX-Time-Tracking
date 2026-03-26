-- Recover hours for approved service tickets that have 0 total_hours but matching time entries exist.
-- Run in Supabase Dashboard → SQL Editor
--
-- This fixes tickets like MW_26018, MW_26019, MW_26026, MW_26029 that show 0.00 because:
-- 1. The service_tickets had project_id=null (merge couldn't match to base ticket from time entries)
-- 2. total_hours and edited_hours were never persisted at approval time
--
-- The script:
-- 1. Sets project_id from the project used by time entries for that date/user/customer
-- 2. Backfills total_hours and edited_hours from aggregated time entries

DO $$
DECLARE
  r RECORD;
  v_project_id UUID;
  v_total_hours NUMERIC;
  v_edited_hours JSONB;
  v_edited_descriptions JSONB;
  v_updated INT := 0;
BEGIN
  FOR r IN (
    SELECT st.id, st.date, st.user_id, st.customer_id, st.ticket_number
    FROM public.service_tickets st
    WHERE st.ticket_number IS NOT NULL
      AND (st.is_discarded IS NOT TRUE OR st.is_discarded IS NULL)
      AND (st.total_hours IS NULL OR st.total_hours = 0)
      AND (st.edited_hours IS NULL OR st.edited_hours = '{}'::jsonb)
  )
  LOOP
    -- Get project_id and totals from first matching time entry
    SELECT te.project_id, SUM(te.hours)::NUMERIC
    INTO v_project_id, v_total_hours
    FROM public.time_entries te
    JOIN public.projects p ON p.id = te.project_id
    WHERE te.date = r.date
      AND te.user_id = r.user_id
      AND p.customer_id = r.customer_id
      AND te.billable = true
      AND te.project_id IS NOT NULL
    GROUP BY te.project_id
    LIMIT 1;

    IF v_project_id IS NOT NULL AND v_total_hours > 0 THEN
      -- Build edited_hours and edited_descriptions by rate_type
      -- Format: {"Shop Time": [4, 2, 2], "Travel Time": [1]}, {"Shop Time": ["d1","d2"], ...}
      SELECT
        jsonb_object_agg(rt, hrs) AS edited_hours,
        jsonb_object_agg(rt, descs) AS edited_descriptions
      INTO v_edited_hours, v_edited_descriptions
      FROM (
        SELECT
          COALESCE(te.rate_type, 'Shop Time') AS rt,
          jsonb_agg(te.hours ORDER BY te.created_at) AS hrs,
          jsonb_agg(COALESCE(te.description, '') ORDER BY te.created_at) AS descs
        FROM public.time_entries te
        JOIN public.projects p ON p.id = te.project_id
        WHERE te.date = r.date
          AND te.user_id = r.user_id
          AND p.customer_id = r.customer_id
          AND te.billable = true
          AND te.project_id IS NOT NULL
        GROUP BY COALESCE(te.rate_type, 'Shop Time')
      ) sub;

      UPDATE public.service_tickets
      SET
        project_id = COALESCE(project_id, v_project_id),
        total_hours = v_total_hours,
        is_edited = true,
        edited_hours = v_edited_hours,
        edited_descriptions = v_edited_descriptions
      WHERE id = r.id;

      v_updated := v_updated + 1;
      RAISE NOTICE 'Updated %: project_id=%, total_hours=%', r.ticket_number, v_project_id, v_total_hours;
    END IF;
  END LOOP;

  RAISE NOTICE 'Recovered hours for % ticket(s)', v_updated;
END $$;
