# Service Tickets: Drafts vs Approved

## Model

- **Drafts (and Submitted)** = built **only from time entries**. Live, editable. Grouped by date, user, customer, project, and PO/AFE. If the user has saved a draft, we link that base ticket to the draft record (`_matchedRecordId`) for save/submit and workflow status; the ticket content (entries, hours) always comes from time entries.
- **Approved** = **only from the database**. Once a ticket is approved (ticket number assigned), it is locked in and no longer linked to time entries. Display is built from the `service_tickets` row: hours from `edited_hours` / `total_hours`, header from `header_overrides`, `entries = []`.

So: drafts = time entries → tickets; approved = DB rows → tickets. No merge of approved records with time entries.

## Why

- Drafts stay in sync with the calendar: change time entries, the draft ticket updates.
- Approved tickets are fixed at approval time: deleting or changing time entries does not change an approved ticket.

## Implementation

1. **Base tickets** = `groupEntriesIntoTickets(billableEntries)` (from time entries).
2. **Approved records** = `service_tickets` rows with `ticket_number` set and not discarded.
3. **Claimed base tickets**: each approved record can "claim" one base ticket (same date, user, customer, project, and PO/AFE when present). That base ticket is excluded from the draft list so the same work does not appear as both draft and approved.
4. **Draft list** = base tickets that are not claimed, each with `_matchedRecordId` = matching draft/submitted record id (if any).
5. **Approved list** = each approved record turned into one ticket via `buildApprovedTicketFromRecord` (DB-only; no entries).
6. **Final `tickets`** = draft list + approved list.
