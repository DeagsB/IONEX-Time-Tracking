-- Migration: Add quantity column to user_expenses for qty × rate breakdown
--
-- Purpose: Receipts may cover multiple units of the same item (e.g. 10 power cords
-- at $5.00 each = $50.00). Storing quantity lets the customer-facing invoice format
-- the line as "10 × $5.00 = $50.00" instead of just "$50.00", consistent with how
-- service_ticket_expenses lines (Truck Hours, Mileage, etc.) are already shown.
--
-- The amount column remains the line subtotal (quantity × rate). Rate per unit is
-- derived as amount / quantity. Existing rows default to quantity=1, preserving
-- prior behaviour (line shown as a single $amount).

ALTER TABLE public.user_expenses
  ADD COLUMN IF NOT EXISTS quantity DECIMAL(10, 2) DEFAULT 1;

COMMENT ON COLUMN public.user_expenses.quantity IS
  'Number of units this receipt line represents. Total amount = quantity × rate. Defaults to 1 for single-item receipts.';
