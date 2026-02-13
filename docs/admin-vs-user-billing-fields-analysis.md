# Why Admin Sees Correct Billing Fields, Non-Admin Sees Wrong

## Root Cause: Wrong Record Matching + Legacy Fallback

### The Problem

When `header_overrides` uses the legacy format (only `approver_po_afe` combined string, no separate `approver`/`po_afe`/`cc`), the record's billing key is computed as `'_::_::_'`:

```ts
// getRecordBillingKey uses: buildBillingKey(ov.approver ?? '', ov.po_afe ?? '', ov.cc ?? '')
// When only approver_po_afe exists → approver/po_afe/cc are undefined → '_::_::_'
```

### Legacy Fallback 1 (the bug)

In `findMatchingTicketRecord` and the tickets merge logic:

```ts
// Legacy fallback 1: base ticket has billing key but record has legacy key
if (!found && ticketBillingKey !== legacyBillingKey) {
  const legacyMatches = existingTickets?.filter(
    et => baseFilter(et) && getRecordBillingKey(et) === legacyBillingKey
  ) || [];
  found = legacyMatches.find(...) || legacyMatches[0];
}
```

This matches a ticket with **specific** billing info (e.g. `'John::PO123::CC456'`) to a **legacy** record (key `'_::_::_'`). The legacy record has `approver_po_afe` as a combined string. We then apply that record's `header_overrides` to the ticket, overwriting correct entry values with the wrong combined string.

### Why Admin Correct, Non-Admin Wrong?

1. **Record creation timing**: When someone opens a ticket, `getOrCreateTicketRecord` creates a new record with proper `approver`/`po_afe`/`cc` from the billing key. That record has the correct key.

2. **Admin flow**: Admins often view tickets that were already opened (by them or others). A proper record often exists. Primary match succeeds → correct display.

3. **User flow**: Non-admins only see their own tickets. Their `existingTickets` query is filtered to `user_id = user.id`. If they have **old legacy records** (from before separate fields existed) and **no proper record yet** (ticket not opened, or query not refetched after create), the primary match fails. Legacy fallback 1 kicks in → we match to the legacy record → wrong display.

4. **Query invalidation**: When opening a new ticket, we create the record but use `refetchType: 'none'`. So `existingTickets` may not include the newly created record. We keep matching against the old set, which can contain only the legacy record.

### Summary

| Scenario | Ticket billing key | Records available | Match result | Display |
|----------|--------------------|-------------------|--------------|---------|
| Admin, ticket already opened | `John::PO123::CC456` | Proper record exists | Primary match | Correct |
| User, first time opening | `John::PO123::CC456` | Only legacy record | Legacy fallback 1 | Wrong (combined string) |
| User, after refetch | `John::PO123::CC456` | Proper + legacy | Primary match | Correct |

### Fix (no parsing)

**Remove or restrict Legacy fallback 1**: Do not match a ticket with a specific billing key to a record with legacy key `'_::_::_'`. That fallback incorrectly applies legacy `approver_po_afe` to tickets that have proper entry data. If no exact match exists, create a new record (which `getOrCreateTicketRecord` already does when opening) rather than reusing a legacy record.
