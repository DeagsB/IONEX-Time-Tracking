# Service Tickets: Drafts vs Locked (Submitted/Approved)

## Model

- **Drafts** = built from **time entries only**. Live, editable. Grouped by date+user+customer+project+po_afe.
  - If the user has saved a draft record (workflow_status = 'draft' or 'rejected'), it's linked via `_matchedRecordId`.
  - Content (entries, hours, header) always comes from time entries.

- **Locked (Submitted + Approved)** = built from **DB only**. Once submitted or approved, the ticket is frozen.
  - Time entries no longer affect it.
  - Hours come from `edited_hours` / `total_hours`; header from `header_overrides`.
  - `entries = []` (no time entry link).

## What makes a record "locked"

A DB record is locked if any of:
- `ticket_number` is set (approved by admin), OR
- `workflow_status` is not 'draft' and not 'rejected' (submitted by user)

## How duplicates are prevented

1. Each locked record **claims** its matching base ticket (same date, user, customer, project; prefer same po_afe).
2. Claimed base tickets are **excluded** from the draft list.
3. Draft records are linked 1:1 to base tickets using `usedDraftRecordIds` tracking.
4. Result: each piece of work appears exactly once (either as a draft or as a locked ticket).

## Implementation

1. `baseTickets` = `groupEntriesIntoTickets(billableEntries)`.
2. `lockedRecords` = DB rows that are submitted or approved.
3. `draftRecords` = DB rows with workflow_status 'draft' or 'rejected' and no ticket_number.
4. Claim: each locked record claims one base ticket → `claimedBaseTicketIds`.
5. Draft list: unclaimed base tickets, each linked to at most one draft record.
6. Locked list: each locked record → `buildLockedTicketFromRecord` (DB-only).
7. `tickets` = draft list + locked list.
