import { ticketExpenseLineHasAttachedReceipt } from './ticketExpenseReceiptMatch';

/**
 * Ticket expense categories that can appear on payroll reimbursement without a linked guest receipt
 * (mileage, company truck / laptop-style equipment, per diem).
 */
export function ticketExpensePayrollSkipsReceiptRequirement(exp: {
  expense_type?: string;
  description?: string;
  needs_reimbursement?: boolean | null;
}): boolean {
  if (exp.needs_reimbursement === false) return true;
  const expType = (exp.expense_type || '').toLowerCase();
  const desc = (exp.description || '').toLowerCase();
  if (expType === 'travel') return true;
  if (expType === 'equipment') return true;
  if (expType === 'subsistence' && desc.includes('per diem')) return true;
  return false;
}

export function ticketExpenseRequiresLinkedReceiptForPayroll(exp: {
  expense_type?: string;
  description?: string;
  needs_reimbursement?: boolean | null;
}): boolean {
  if (exp.needs_reimbursement === false) return false;
  return !ticketExpensePayrollSkipsReceiptRequirement(exp);
}

/** Linked billable receipts approved for payout (matches Payroll user_expenses filter). */
export function ticketExpenseHasPayrollEligibleLinkedReceipt(
  exp: { service_ticket_id?: string; description?: string | null },
  linkedApprovedReceipts: Array<{ service_ticket_id?: string | null; description?: string | null }>
): boolean {
  const tid = exp.service_ticket_id;
  if (!tid) return false;
  const forTicket = linkedApprovedReceipts.filter((r) => String(r.service_ticket_id ?? '') === String(tid));
  return ticketExpenseLineHasAttachedReceipt(exp.description, forTicket);
}

/**
 * Initial reimbursement_status when creating a ticket expense row.
 * Hotel / misc receipt lines stay pending until a linked receipt is saved (then set to approved).
 */
export function initialReimbursementStatusForTicketExpense(input: {
  needs_reimbursement: boolean;
  expense_type?: string;
  description?: string;
  isAdmin: boolean;
}): string | undefined {
  if (!input.needs_reimbursement) return undefined;
  if (ticketExpensePayrollSkipsReceiptRequirement(input)) {
    return input.isAdmin ? 'approved' : 'pending';
  }
  return 'pending';
}
