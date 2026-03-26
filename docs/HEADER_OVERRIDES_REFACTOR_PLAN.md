# Header Overrides Refactoring Plan

## Current State Summary

Header overrides are user-editable fields (customer info, Service Location, PO/AFE/CC, Approver, Coding, Other) stored in `service_tickets.header_overrides` (JSONB). They are used for:
- **All tickets**: User/admin edits saved to header_overrides only. Time entries are NOT updated when the header is edited.
- **Approved tickets**: Frozen rates also stored in header_overrides.

## Pain Points Identified

1. **Logic scattered across 6+ files**: ServiceTickets.tsx, supabaseServices.ts, serviceTickets.ts, Invoices.tsx, pdfFromHtml.ts
2. **Multiple merge/source rules**: "Use entry values when entries newer", "Use header_overrides for approved", "Legacy fallback when empty" – hard to reason about
3. **Billing key extraction duplicated**: `getRecordGroupingKey`, `getRecordBillingKey` repeated in ServiceTickets, supabaseServices, Invoices with slight variations
4. **editableTicket ↔ header_overrides mapping**: Manual field-by-field mapping in save and load; easy to miss fields or get keys wrong
5. **Matching complexity**: 4+ fallback layers for matching records to base tickets (full key, grouping key, legacy, record-empty)
6. **Inconsistent typing**: `Record<string, string | number>`, `HeaderOverrides`, `{ approver_po_afe?: string }` used interchangeably

## Proposed Refactor

### Phase 1: Centralize Types & Constants

**New file: `frontend/src/types/headerOverrides.ts`**

```ts
/** Canonical header override structure - single source of truth */
export interface HeaderOverrides {
  // Customer / service info
  customer_name?: string;
  address?: string;
  city_state?: string;
  zip_code?: string;
  phone?: string;
  email?: string;
  contact_name?: string;
  location_code?: string;
  po_number?: string;
  service_location?: string;
  // Billing fields
  approver?: string;
  po_afe?: string;
  cc?: string;
  other?: string;
  // Other
  tech_name?: string;
  project_number?: string;
  date?: string;
  // Frozen rates (approved only)
  rate_rt?: number;
  rate_tt?: number;
  rate_ft?: number;
  rate_shop_ot?: number;
  rate_field_ot?: number;
  /** @deprecated Legacy combined field */
  approver_po_afe?: string;
}

/** Keys that map 1:1 from editableTicket form to header_overrides */
export const EDITABLE_TO_HEADER_OVERRIDE_KEYS = [
  'customer_name', 'address', 'city_state', 'zip_code', 'phone', 'email',
  'contact_name', 'service_location', 'location_code', 'po_number',
  'approver', 'po_afe', 'cc', 'other', 'tech_name', 'project_number', 'date'
] as const;
```

### Phase 2: Centralize Billing Key Logic

**In `serviceTickets.ts`** – keep as single place for:
- `buildBillingKey(approver, po_afe, cc)`
- `buildGroupingKey(po_afe)`
- `getTicketBillingKey(ticketId)` – extract from ticket.id
- `getRecordBillingKey(record)` – extract from record.header_overrides
- `getRecordGroupingKey(record)` – extract from record.header_overrides

**Remove duplicates** from ServiceTickets.tsx, supabaseServices.ts, Invoices.tsx – import from serviceTickets.

### Phase 3: Single "Resolve Header Values" Function

**New: `resolveHeaderValuesForDisplay(ticket, record, options)`**

Returns the final values to show (customer name, approver, etc.) based on:
- Ticket (base data from entries/project/customer)
- Record (header_overrides, is_edited, workflow_status)
- Options: `{ isAdmin, useEntryValues }`

One function replaces the scattered merge logic in:
- ticketsWithNumbers (list display)
- handleRowClick async (form when opening)
- applyHeaderOverridesToTicket (for tickets that already have base data)

### Phase 4: Single "Build Header Overrides for Save" Function

**New: `editableTicketToHeaderOverrides(editable)`**

Maps the form state to the DB shape. Used in:
- performSave (ServiceTickets)
- buildApprovalHeaderOverrides (when approving)
- getOrCreateTicket (when creating with billing key)

### Phase 5: Simplify Matching

**New: `findMatchingRecord(baseTicket, records)`** in serviceTickets.ts

Single function with clear fallback order:
1. Match by id (standalone tickets)
2. Match by date+user+customer+project + full billing key
3. Match by date+user+customer+project + grouping key
4. Match by date+user+customer+project when record has legacy/empty key

Used by: merge logic, findMatchingTicketRecord, standalone detection, Invoices.

### Phase 6: Save Flow Simplification

**performSave** – one clear path:
1. Ensure record exists (getOrCreateTicketRecord)
2. Build header_overrides from editableTicket (use shared function)
3. Update record: `{ location, header_overrides, is_edited, edited_descriptions, edited_hours, total_hours, total_amount }`
4. Invalidate queries (no push to time entries)

### Phase 7: Load Flow Simplification

**When opening ticket** – one clear path:
1. Fetch record (with header_overrides)
2. Call `resolveHeaderValuesForDisplay(ticket, record, { isAdmin, useEntryValues })`
3. setEditableTicket with result
4. If is_edited: load service rows from edited_descriptions/edited_hours

---

## Implementation Order

1. **Phase 1** – Create types file, no behavior change
2. **Phase 2** – Consolidate billing key helpers, remove duplicates
3. **Phase 4** – Build `editableTicketToHeaderOverrides`, use in performSave
4. **Phase 3** – Build `resolveHeaderValuesForDisplay`, use in ticketsWithNumbers and handleRowClick
5. **Phase 5** – Consolidate matching into single function
6. **Phase 6 & 7** – Simplify save/load flows

## Files to Modify

| File | Changes |
|------|---------|
| `frontend/src/types/headerOverrides.ts` | NEW – types and constants |
| `frontend/src/utils/serviceTickets.ts` | Add resolveHeaderValuesForDisplay, editableTicketToHeaderOverrides, findMatchingRecord; export billing helpers |
| `frontend/src/pages/ServiceTickets.tsx` | Use new functions; remove duplicated logic |
| `frontend/src/services/supabaseServices.ts` | Import billing helpers from serviceTickets; remove local copies |
| `frontend/src/pages/Invoices.tsx` | Import matching/billing from serviceTickets |
| `frontend/src/utils/pdfFromHtml.ts` | Use HeaderOverrides type |

## Risk Mitigation

- Implement phase-by-phase; run tests/build after each
- Keep legacy `approver_po_afe` support during refactor
- Consider feature flag if deploying incrementally
