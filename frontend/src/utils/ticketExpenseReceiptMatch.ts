/** Same trimming semantics as userExpensesService._removeLinkedTicketExpense (description match). */
export function normalizedTicketExpenseDescription(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase();
}

/** True if a visible service_ticket_expenses line pairs with this user_expense receipt. */
export function receiptHasMatchingTicketExpenseLine(
  receiptDescription: string | undefined | null,
  lines: Array<{ description?: string | null }>
): boolean {
  const rd = normalizedTicketExpenseDescription(receiptDescription);
  if (!rd) return false;
  return lines.some((e) => normalizedTicketExpenseDescription(e.description) === rd);
}

/** True if a ticket expense line already has a user_expenses receipt on this ticket with the same description. */
export function ticketExpenseLineHasAttachedReceipt(
  lineDescription: string | undefined | null,
  receipts: Array<{ description?: string | null }>
): boolean {
  const ld = normalizedTicketExpenseDescription(lineDescription);
  if (!ld) return false;
  return receipts.some((r) => normalizedTicketExpenseDescription(r.description) === ld);
}

/**
 * Payroll / totals: do not double-count a linked user_expense when the ticket already
 * covers it. Two ways a ticket-expense line can claim a receipt:
 *   1. Explicit link via service_ticket_expenses.user_expense_id === receipt.id
 *      (the receipt-linking flow — one receipt fans out to many ticket lines).
 *   2. Direct apply-to-ticket: receipt.service_ticket_id matches a reimbursable
 *      line on that ticket with the same description (legacy flow).
 * Either case → reimbursement comes from the ticket lines, so the receipt itself
 * must be skipped to avoid paying it twice.
 */
export function linkedUserExpenseRedundantWithTicketExpenseLine(
  receipt: { id?: string | null; description?: string | null; service_ticket_id?: string | null },
  ticketExpenseRows: Array<{
    service_ticket_id?: string;
    description?: string | null;
    needs_reimbursement?: boolean | null;
    user_expense_id?: string | null;
  }>
): boolean {
  const rid = receipt.id ? String(receipt.id) : '';
  if (rid) {
    const linkedById = ticketExpenseRows.some(
      (te) => String(te.user_expense_id ?? '') === rid && te.needs_reimbursement !== false
    );
    if (linkedById) return true;
  }
  const tid = receipt.service_ticket_id;
  if (!tid) return false;
  const rd = normalizedTicketExpenseDescription(receipt.description);
  if (!rd) return false;
  return ticketExpenseRows.some(
    (te) =>
      String(te.service_ticket_id ?? '') === String(tid) &&
      normalizedTicketExpenseDescription(te.description) === rd &&
      te.needs_reimbursement !== false
  );
}
