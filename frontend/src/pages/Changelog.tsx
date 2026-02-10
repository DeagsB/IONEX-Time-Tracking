import React from 'react';

const LATEST_ADDED = [
  '**Inactive clients and projects** – Clients and projects are no longer deleted. Admins can **Mark inactive** to hide them from the main list. A **Show inactive** toggle (admin only) reveals an Inactive section where items can be edited or **Reactivate**d. Only admins can mark items inactive or see the inactive section.',
  '**Project number – admin only** – Only admins can add or edit the Project number (Job ID). When a regular user adds or edits a project, the Project number field is hidden; new projects created by non-admins are saved without a project number.',
  '**Admin: projects missing project number** – In the Projects list, projects without a project number are highlighted in green (green left border, light green row, **Missing #** badge). A green dot appears next to **Projects** in the sidebar when any project is missing a project number.',
  '**Rejection notes on service tickets** – When an admin rejects a submitted service ticket, they can optionally enter a reason. Rejected tickets move back to the user\'s **Drafts** tab; when the user opens the ticket, the rejection reason is shown at the top in a highlighted banner so they know why it was rejected and can revise accordingly.',
  '**Create service ticket from scratch** – You can create a new service ticket without any time entries. In the form, choosing a customer fills in address, contact, and related info; choosing a project filters by that customer. Technician name is pre-filled. Ticket number is assigned when an admin approves.',
  '**Inline create Customer and Project** – In the "Create Service Ticket" panel, the Customer and Project dropdowns include options to add a new customer or a new project without leaving the form.',
  '**Bulk "Mark as Submitted"** – On the Service Tickets page you can select multiple tickets and use a single action to mark them all as Submitted (workflow status set to approved).',
  '**Discard / Restore service tickets** – Service tickets can be "discarded" (hidden from the main list but not deleted). A "Show Discarded" filter reveals them so they can be restored. This is available to all signed-in users, not only admins.',
  '**PO/AFE on time entries** – When adding or editing a time entry and a customer is selected, a **PO/AFE** field appears between Location and Rate Type. It is pre-filled from the selected project\'s Approver/PO/AFE and can be edited; the value is saved with the time entry.',
    '**"Other" on service ticket PDF** – The exported service ticket PDF now has an "Other" column on the same row as PO/CC/AFE (same style as the Job ID / Job Type row).',
  '**Payroll for all users** – The Payroll page is now available to every signed-in user. Non-admins see only their own payroll data ("My Payroll") and cannot click through to another user\'s calendar from the table.',
  '**Service Ticket Status Tabs** – Added tabs to the Service Tickets page to filter by status: **Drafts** (default view), **Submitted**, and **Approved**. This organizes tickets by workflow stage. Existing filters (Date, Customer) apply within each tab.',
  '**Admin Approve / Reject on service tickets** – When an admin opens a ticket that is submitted by the user but not yet approved, the bottom of the ticket shows **Approve** and **Reject** buttons (Export PDF is hidden until the ticket is approved). Rejected tickets return to the user\'s **Drafts** tab (at the top), show a **Rejected** badge and highlight in the list, and a notification badge appears next to **Service Tickets** in the sidebar until the user addresses them.',
];

const LATEST_CHANGED = [
  '**Admin Approve / Reject buttons** – On the service ticket detail, **Reject** is on the left (red button) and **Approve** on the right (green button).',
  '**Service Tickets default tab** – For admins, the Service Tickets page opens with the **Submitted** tab selected by default; non-admins still default to **Drafts**.',
  '**Sidebar for non-admin users** – The **ANALYZE** section (with Payroll) is visible to all users. Payroll appears below the MANAGE section (Projects, Clients, Service Tickets, Settings) in the sidebar.',
  '**Service ticket form** – The label "Project Number" in the create-ticket form has been renamed to **"Project"**.',
  '**Time entry form** – The note "Different locations create separate service tickets" now appears **above** the Location input instead of below it.',
  '**Customers and projects** – Any authenticated user can edit clients and projects. Delete has been removed: clients and projects are now **Mark inactive** (admin only); inactive items are hidden and only visible to admins in a **Show inactive** section.',
];

const LATEST_REMOVED = [
  '**Feedback & Issues page** – The Feedback & Issues (bug reports) page and sidebar link have been removed from the app.',
];

const LATEST_FIXED = [
  '**Service tickets:** Manually created (standalone) service tickets now show up in the main ticket list. Date range and employee filters now apply to all tickets, including standalone ones. Admins can approve manually created service tickets. PO/CC/AFE and Other values now appear correctly on the service ticket PDF export. Deleting the last time entry for a service ticket now reliably deletes the ticket itself. "Ghost" zero-hour tickets from location mismatch have been cleaned up. Tickets in the Submitted tab with statuses such as PDF Exported now correctly show "✓ Submitted" in the action column.',
  '**Time entries** – Opening the edit modal for a running timer no longer causes a build/TypeScript error (missing po_afe in state).',
  '**Expenses** – The confirmation dialog when deleting an expense has been removed; deletion happens immediately when you choose delete.',
  '**Calendar (admin viewing another user)** – When an admin views another user\'s calendar, the current user\'s live timer no longer appears on that calendar; only the viewed user\'s entries are shown.',
];

const EARLIER_SERVICE_TICKETS = [
  'Save Changes and unsaved-changes confirmation; pending changes highlighted.',
  'Header fields (customer/service info, Service Location, Approver/PO/AFE, Other) saved in header_overrides.',
  'Expenses can be added/edited/removed with changes applied on Save.',
  'PDF export layout and styling improvements; lock message when editing another user\'s ticket.',
  'Entry-level location and PO/AFE take priority over project/customer defaults on tickets.',
  'Different locations no longer merge into one ticket; matching includes location.',
  'Non-admin users create draft ticket records (no ticket number) when opening or saving a ticket.',
  'Changelog link under Settings (admin only).',
];

const EARLIER_TIME_ENTRY = [
  'Add Time Entry modal: taller (min 75vh) for better dropdown visibility; scrollable (max height 90vh) on small screens.',
  'Editable hours field in Add Time Entry auto-adjusts end time.',
  'Customer and project required before enabling Add/play; button greyed out until selected.',
  'Location no longer auto-populated from last entry in manual time entry modals.',
  'Header: PO/AFE field on live timer; project details on second row.',
  'IONEX Systems default to Internal; skipped for service ticket creation.',
];

const EARLIER_PAYROLL = [
  'Current and Previous Pay Period buttons; payday shown for the selected period.',
  'Project legend with numbers and full name on hover; horizontal scroll when there are many projects.',
];

const EARLIER_GENERAL = [
  'Bug fixes for customer updates, service ticket date handling, expense error messages, and ticket visibility (e.g. Brooks District).',
];

function renderList(items: string[], style: React.CSSProperties = {}) {
  return (
    <ul style={{ margin: 0, paddingLeft: '20px', color: 'var(--text-primary)', fontSize: '14px', lineHeight: 1.6, ...style }}>
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: '8px' }}>
          <span
            dangerouslySetInnerHTML={{
              __html: item.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'),
            }}
            style={{ display: 'inline' }}
          />
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        padding: '20px 24px',
        backgroundColor: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
      }}
    >
      <h2 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--primary-color)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function Changelog() {
  return (
    <div style={{ padding: '24px', maxWidth: '720px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '28px', fontWeight: '700', marginBottom: '8px', color: 'var(--text-primary)' }}>
        Changelog
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '32px' }}>
        Notable changes to IONEX Time Tracking, in plain language.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <h2 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '4px' }}>
          Latest changes
        </h2>

        <Section title="Added">{renderList(LATEST_ADDED)}</Section>
        <Section title="Changed">{renderList(LATEST_CHANGED)}</Section>
        <Section title="Removed">{renderList(LATEST_REMOVED)}</Section>
        <Section title="Fixed">{renderList(LATEST_FIXED)}</Section>

        <h2 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)', marginTop: '8px', marginBottom: '4px' }}>
          Earlier improvements (summary)
        </h2>

        <Section title="Service tickets">{renderList(EARLIER_SERVICE_TICKETS)}</Section>
        <Section title="Time entry & calendar">{renderList(EARLIER_TIME_ENTRY)}</Section>
        <Section title="Payroll / Week view">{renderList(EARLIER_PAYROLL)}</Section>
        <Section title="General">{renderList(EARLIER_GENERAL)}</Section>
      </div>
    </div>
  );
}
