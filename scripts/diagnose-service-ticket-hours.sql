-- Diagnose service tickets showing 0 hours in the list
-- Run in Supabase Dashboard → SQL Editor
-- Use this to check if MW (or other) tickets have total_hours / edited_hours in the DB

SELECT
  st.id,
  st.ticket_number,
  st.date,
  u.first_name || ' ' || u.last_name AS user_name,
  c.name AS customer_name,
  st.total_hours,
  st.is_edited,
  st.edited_hours
FROM public.service_tickets st
LEFT JOIN public.users u ON u.id = st.user_id
LEFT JOIN public.customers c ON c.id = st.customer_id
WHERE st.ticket_number LIKE 'MW_%'
  AND (st.is_discarded IS NOT TRUE OR st.is_discarded IS NULL)
ORDER BY st.date DESC, st.ticket_number;
