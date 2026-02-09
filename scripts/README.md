# Scripts

One-off and maintenance scripts for IONEX Time Tracking.

## remove-duplicate-service-tickets-morgan-wolfe.sql

Removes duplicate service tickets for **Morgan Wolfe** that were created when location was added to service ticket matching (same date + customer ended up with multiple tickets, e.g. one with empty location and one with a location).

**How to run**

1. Open **Supabase Dashboard** → your project → **SQL Editor**.
2. (Optional) Run the **PREVIEW** block (uncomment it) to see which duplicate groups exist and which ticket IDs will be kept vs deleted.
3. Run the main **DO $$ ... $$** block. It will:
   - Find Morgan Wolfe’s `user_id` from `public.users` (first_name = 'Morgan', last_name = 'Wolfe').
   - Find duplicate groups: same `(date, user_id, customer_id)` with more than one row.
   - For each group, **keep** one ticket (prefer the one with `ticket_number` set, then smallest `id`).
   - Delete related rows in `service_ticket_expenses` for the tickets being removed.
   - Delete the duplicate `service_tickets` rows.

Only the **production** table `service_tickets` is modified; `service_tickets_demo` is not changed.
