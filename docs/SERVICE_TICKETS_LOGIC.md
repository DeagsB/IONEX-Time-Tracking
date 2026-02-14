# Service Tickets: Base Ticket and Standalone Logic

## Overview

The Service Tickets page displays tickets from **two data sources** that must be unified:

1. **Base tickets** – inferred from time entries via `groupEntriesIntoTickets()`
2. **Existing records** – rows in the `service_tickets` table (saved drafts and approved tickets)

## Why Both Are Needed

- **Base tickets** come from billable time entries. They have `entries[]`, calculated hours, and customer/project info. They represent work that may or may not be saved yet.
- **Existing records** come from the database. They have `ticket_number`, `edited_hours`, `header_overrides`, and workflow status. They represent saved or approved tickets.

Neither source alone is enough:

- Base tickets alone: approved tickets whose time entries were deleted would disappear.
- Existing records alone: we would lose the `entries[]` array and live rates from time entries for tickets that still have entries.

## What the Logic Does

### 1. Merge (DB record + base ticket)

When a base ticket matches an existing record (same date, user, customer, project, billing key):

- Merge: base ticket structure + record data (ticket_number, edited_hours, header_overrides).
- Use the base ticket’s `entries[]` for display.
- Use the record’s `edited_hours` if `is_edited` is true.
- Use `total_hours` from the record if the base ticket has 0 hours (e.g. entries deleted, or orphaned record).

### 2. Standalone (DB record only)

When an existing record has no matching base ticket:

- Build a synthetic ticket from the record (customer, user, hours from `edited_hours` or `total_hours`).
- `entries` is empty.
- Used for approved tickets whose time entries were deleted, or records with different `project_id` (legacy), or records created outside the current view.

### 3. Draft (base ticket only)

When a base ticket has no matching existing record:

- Show as-is (no ticket number, draft workflow).
- Used for new work that hasn’t been saved yet.

## Matching Rules (no billing key)

Matching between base tickets and existing records uses **date + user + customer + project only**. Billing key (approver/PO/AFE/CC) is not used for matching, so the approved list is 1:1 with the database: every approved record appears exactly once (merged or standalone).

- **Base tickets**: each base ticket can only be merged with one record (`usedBaseTicketIds`).
- **Records**: each record is merged with at most one base ticket (first match) or shown as standalone.

## Refactor (2025)

The logic was refactored from a **base-first** to an **existing-first** approach:

- **Before**: iterate base tickets → find matching record → merge → append standalone (records not used).
- **After**: iterate existing records → find matching base ticket → merge or standalone → append drafts (base tickets not used).

This matches the behavior of the Invoices page and makes the flow clearer: "for each saved record, show it (merged or standalone); then add orphan base tickets as drafts."
