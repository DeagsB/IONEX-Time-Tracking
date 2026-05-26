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

/** Linked billable receipts approved for payout (matches Payroll user_expenses filter).
 *  Two link paths count — either is sufficient:
 *    1. Explicit `user_expense_id` link from the ticket-expense row to a receipt id
 *       (the modern Apply-to-Ticket flow, where one receipt fans out to many lines).
 *    2. Legacy description-match against a receipt whose service_ticket_id is the
 *       same ticket. This worked for the old direct-apply flow before user_expense_id
 *       existed; we keep it so historical rows still resolve.
 *  Previously only path #2 was checked, which silently dropped explicit-link lines
 *  whose description didn't match the receipt's (e.g. Chase Gibbon's expenses).
 */
export function ticketExpenseHasPayrollEligibleLinkedReceipt(
  exp: { service_ticket_id?: string; description?: string | null; user_expense_id?: string | null },
  linkedApprovedReceipts: Array<{ id?: string | null; service_ticket_id?: string | null; description?: string | null }>
): boolean {
  const linkedId = exp.user_expense_id ? String(exp.user_expense_id) : '';
  if (linkedId && linkedApprovedReceipts.some((r) => String(r.id ?? '') === linkedId)) return true;
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
