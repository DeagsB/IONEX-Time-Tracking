-- Backfill service_ticket_expenses.user_expense_id from user_expenses
-- where a ticket-expense and a receipt share the same service_ticket_id + description
-- but the link wasn't recorded at create time.
--
-- Why: payroll dedup can fall back to description matching, but only works when both
-- rows are in the *same* pay period. A receipt dated April 14 and its matching
-- ticket-expense on a ticket dated April 12 sit in adjacent periods, and without the
-- explicit user_expense_id link payroll reimburses Chase Gibbon twice. Setting the
-- link makes the receiptIdsCoveredByTicketLink dedup catch it directly.
--
-- Safe to re-run: only touches NULL user_expense_id rows, and only when a unique
-- 1-to-1 match exists between the receipt and the ticket-expense.

WITH match_candidates AS (
  SELECT
    ste.id AS ste_id,
    ue.id AS ue_id,
    COUNT(*) OVER (PARTITION BY ste.id) AS ste_match_count,
    COUNT(*) OVER (PARTITION BY ue.id) AS ue_match_count
  FROM public.service_ticket_expenses ste
  JOIN public.user_expenses ue
    ON ue.service_ticket_id = ste.service_ticket_id
   AND LOWER(TRIM(ue.description)) = LOWER(TRIM(ste.description))
  WHERE ste.user_expense_id IS NULL
    AND ste.needs_reimbursement = true
),
unique_matches AS (
  SELECT ste_id, ue_id
  FROM match_candidates
  WHERE ste_match_count = 1
    AND ue_match_count = 1
)
UPDATE public.service_ticket_expenses ste
SET user_expense_id = um.ue_id
FROM unique_matches um
WHERE ste.id = um.ste_id;
