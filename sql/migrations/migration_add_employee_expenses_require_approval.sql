-- Migration: Per-employee opt-in for the expense approval workflow.
--
-- By default expenses skip pending/approved/rejected and flow straight from
-- created → paid (auto-marked once the pay period's payday passes). For
-- specific employees who need oversight, flip this flag on their record and
-- their expenses must be explicitly approved before the auto-sweep will
-- mark them paid.

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS expenses_require_approval BOOLEAN DEFAULT false;

COMMENT ON COLUMN public.employees.expenses_require_approval IS
  'When true, this employee''s receipts and reimbursable ticket expenses must be admin-approved (status=approved) before the auto-sweep marks them paid. Default false (no approval needed).';
