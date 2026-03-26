-- Allow expense_type values the app uses. Client maps UI "Expenses" → "Other"; this also allows
-- "Expenses" if ever stored directly. Coerce any stray values before re-adding the check.
-- Run this in Supabase SQL Editor (or via CLI) if saves fail with service_ticket_expenses_expense_type_check.
ALTER TABLE public.service_ticket_expenses
  DROP CONSTRAINT IF EXISTS service_ticket_expenses_expense_type_check;

UPDATE public.service_ticket_expenses
SET expense_type = 'Other'
WHERE expense_type::text IS NOT NULL
  AND trim(expense_type::text) <> ''
  AND lower(trim(expense_type::text)) NOT IN (
    'travel', 'subsistence', 'hotel', 'equipment', 'other', 'expenses'
  );

ALTER TABLE public.service_ticket_expenses
  ADD CONSTRAINT service_ticket_expenses_expense_type_check
  CHECK (
    expense_type::text IN (
      'Travel',
      'Subsistence',
      'Hotel',
      'Equipment',
      'Other',
      'Expenses'
    )
  );
