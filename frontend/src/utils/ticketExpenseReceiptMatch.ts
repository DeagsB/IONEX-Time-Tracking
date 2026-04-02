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
 * Payroll / totals: do not double-count a linked user_expense when the ticket already has a matching
 * reimbursable line (same normalized description).
 */
export function linkedUserExpenseRedundantWithTicketExpenseLine(
  receipt: { description?: string | null; service_ticket_id?: string | null },
  ticketExpenseRows: Array<{
    service_ticket_id?: string;
    description?: string | null;
    needs_reimbursement?: boolean | null;
  }>
): boolean {
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
