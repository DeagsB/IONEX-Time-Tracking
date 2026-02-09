# Changelog

Notable changes to **IONEX Time Tracking** are listed here in plain language. The format is inspired by [Keep a Changelog](https://keepachangelog.com/).

---

## Latest changes

### Added

- **Changelog (full) on Changelog page**  
  The Changelog page now shows both “Latest” and “Earlier” sections, matching the full CHANGELOG.md so you can see the complete history in the app.

- **Create service ticket from scratch**  
  You can create a new service ticket without any time entries. In the form, choosing a customer fills in address, contact, and related info; choosing a project filters by that customer. Technician name is pre-filled. Ticket number is assigned when an admin approves.

- **Inline create Customer and Project**  
  In the “Create Service Ticket” panel, the Customer and Project dropdowns include options to add a new customer or a new project without leaving the form.

- **Bulk “Mark as Submitted”**  
  On the Service Tickets page you can select multiple tickets and use a single action to mark them all as Submitted (workflow status set to approved).

- **Discard / Restore service tickets**  
  Service tickets can be “discarded” (hidden from the main list but not deleted). A “Show Discarded” filter reveals them so they can be restored. This is available to all signed-in users, not only admins.

- **PO/AFE on time entries**  
  When adding or editing a time entry and a customer is selected, a **PO/AFE** field appears between Location and Rate Type. It is pre-filled from the selected project’s Approver/PO/AFE and can be edited; the value is saved with the time entry.

- **“Other” on service ticket PDF**  
  The exported service ticket PDF now has an “Other” column on the same row as PO/CC/AFE (same style as the Job ID / Job Type row).

- **Payroll for all users**  
  The Payroll page is now available to every signed-in user. Non-admins see only their own payroll data (“My Payroll”) and cannot click through to another user’s calendar from the table.

- **Service Ticket Status Tabs**  
  Added tabs to the Service Tickets page to filter by status: **Drafts** (default view), **Submitted**, and **Approved**. This organizes tickets by workflow stage and makes it easier to find tickets needing action. Existing filters (Date, Customer) apply within each tab.

- **Admin Approve / Reject on service tickets**  
  When an admin opens a ticket that is submitted by the user but not yet approved, the bottom of the ticket shows **Approve** and **Reject** buttons (Export PDF is hidden until the ticket is approved). Rejected tickets return to the user’s **Drafts** tab (at the top of the list), show a **Rejected** badge and highlight in the list, and a notification badge appears next to **Service Tickets** in the sidebar until the user addresses them.

### Changed

- **Admin Approve / Reject buttons**  
  On the service ticket detail, **Reject** is on the left (red button) and **Approve** on the right (green button).

- **Service Tickets default tab**  
  For admins, the Service Tickets page opens with the **Submitted** tab selected by default; non-admins still default to **Drafts**.

- **Sidebar for non-admin users**  
  The **ANALYZE** section (with Payroll) is visible to all users. Payroll appears below the MANAGE section (Projects, Clients, Service Tickets, Settings) in the sidebar.

- **Service ticket form**  
  The label “Project Number” in the create-ticket form has been renamed to **“Project”**.

- **Time entry form**  
  The note “Different locations create separate service tickets” now appears **above** the Location input instead of below it.

- **Service Tickets filter and tabs**  
  The status tabs (Drafts, Submitted, Approved, All Tickets) are now placed **below** the filter area (date range, Customer, Employee, Show Discarded) so filters are applied first, then you switch tabs.

- **Live time entry (header)**  
  The “What are you working on?” field in the header now expands to use the available width on larger windows instead of staying fixed at 600px.

- **Manual time entry – duration**  
  In the edit time entry modal, the duration (e.g. 1.00h) is now editable. Changing it updates the end time from the start time. The value is always shown as **xx.xx** (e.g. 1 → 1.00). On first click/focus, the whole value is selected so you can type to overwrite it.

- **Customers and projects**  
  Any authenticated user can edit and delete customers and projects (previous restrictions were removed).

### Fixed

- **Service tickets**
  - Manually created (standalone) service tickets now show up in the main ticket list.
  - Date range and employee filters now apply to all tickets, including standalone ones.
  - Admins can approve manually created service tickets (they were previously mis-treated as demo tickets and failed to approve).
  - PO/CC/AFE and Other values now appear correctly on the service ticket PDF export.
  - Deleting the last time entry for a service ticket now reliably deletes the ticket itself (fixed an issue where missing customer data prevented cleanup).
  - “Ghost” zero-hour tickets caused by a location mismatch (ticket with empty location vs. time entries with a location) have been cleaned up; orphaned ticket records with no matching time entries by location are no longer left in the list.
  - Tickets in the Submitted tab with statuses such as PDF Exported now correctly show “✓ Submitted” (not “Submit”) in the action column.

- **Time entries**  
  Opening the edit modal for a running timer no longer causes a build/TypeScript error (missing `po_afe` in state).

- **Expenses**  
  The confirmation dialog when deleting an expense has been removed; deletion happens immediately when you choose delete.

- **Calendar (admin viewing another user)**  
  When an admin views another user’s calendar, the current user’s live timer no longer appears on that calendar; only the viewed user’s entries are shown.

---

## Earlier improvements (summary)

### Service tickets
- Save Changes and unsaved-changes confirmation; pending changes highlighted.
- Header fields (customer/service info, Service Location, Approver/PO/AFE, Other) saved in `header_overrides`.
- Expenses can be added/edited/removed with changes applied on Save.
- PDF export layout and styling improvements; lock message when editing another user’s ticket.
- Entry-level location and PO/AFE take priority over project/customer defaults on tickets.
- Different locations no longer merge into one ticket; matching includes location.
- Non-admin users create draft ticket records (no ticket number) when opening or saving a ticket.
- Changelog link under Settings (admin only).

### Time entry & calendar
- Add Time Entry modal: taller (min 75vh) for better dropdown visibility; scrollable (max height 90vh) on small screens.
- Editable hours field in Add Time Entry auto-adjusts end time.
- Customer and project required before enabling Add/play; button greyed out until selected.
- Location no longer auto-populated from last entry in manual time entry modals.
- Header: PO/AFE field on live timer; project details on second row.
- IONEX Systems default to Internal; skipped for service ticket creation.

### Payroll / Week view
- Current and Previous Pay Period buttons; payday shown for the selected period.
- Project legend with numbers and full name on hover; horizontal scroll when there are many projects.

### General
- Bug fixes for customer updates, service ticket date handling, expense error messages, and ticket visibility (e.g. Brooks District).

---

*For exact commit history, use `git log` in the repository.*
