/** Customer-billed line total (quantity × rate). */
export function ticketExpenseBilledAmount(exp: { quantity?: number; rate?: number }): number {
  return (Number(exp.quantity) || 0) * (Number(exp.rate) || 0);
}

/**
 * Dollar base for employee reimbursement on ticket expenses.
 * For hotel and other/misc receipt lines, uses `actual_cost` (pre-markup, includes GST) when set.
 * Other categories (mileage, per diem, truck, etc.) use billed amount.
 */
export function ticketExpenseReimbursementBase(exp: {
  quantity?: number;
  rate?: number;
  actual_cost?: number | null;
  expense_type?: string;
  description?: string;
  needs_reimbursement?: boolean;
}): number {
  const billed = ticketExpenseBilledAmount(exp);
  // Only skip out-of-pocket base when explicitly company-paid; undefined still reimburses like legacy rows.
  if (exp.needs_reimbursement === false) return billed;
  const raw = exp.actual_cost;
  const ac = raw != null ? Number(raw) : NaN;
  if (!(ac > 0) || Number.isNaN(ac)) return billed;
  const expType = (exp.expense_type || '').toLowerCase();
  const desc = (exp.description || '').toLowerCase();
  const isHotelOrMisc =
    expType === 'hotel' ||
    desc.includes('hotel') ||
    expType === 'other' ||
    expType === 'expenses';
  if (!isHotelOrMisc) return billed;
  return ac;
}
