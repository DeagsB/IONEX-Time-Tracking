import React from 'react';

// ─── What's New (summary) ─────────────────────────────────────────────────────
const WHATS_NEW_SUMMARY = `**v1.1.0** – PO/AFE/CC split into separate fields; service ticket handling updated; trash workflow improvements; right-click delete on calendar; auto-save on submit; UI polish. **v1.0.0** – Trash (formerly Discard), New badge, status tabs, approve/reject, and service ticket enhancements.`;

// ─── v1.1.0 ───────────────────────────────────────────────────────────────────
const V110_ADDED = [
  '**Right-click delete on calendar** – Right-click a time entry block on the week view to open a context menu with **Delete**. Uses an in-app confirmation instead of the browser dialog.',
];

const V110_CHANGED = [
  '**PO/AFE/CC (Cost Center) section** – Projects and service tickets now use separate **Approver**, **PO/AFE/CC (Cost Center)**, and **Coding** fields instead of a single combined field. Time entry form shows these as distinct inputs; service ticket header overrides store them separately.',
  '**Service ticket handling** – Header overrides migrated from legacy approver_po_afe format to approver/po_afe/cc keys. Parsing fallbacks removed; data flows directly from the new project columns and editable fields.',
  '**Time entries** – Approver, PO/AFE/CC (Cost Center), and Coding stored in separate columns. Parsing removed; create/edit forms and service ticket building use approver, po_afe, cc directly.',
  '**Trashed tickets** – Restore button moved to the right (where Submit for Approval was). Submit for Approval hidden when in trash. Trashed tickets are view-only until restored.',
  '**Submit for Approval** – Changes are now auto-saved when you click Submit for Approval or Approve; no need to click Save Changes first.',
  '**Show Trash** – Clicking any tab (Drafts, Submitted, Approved, All Tickets) while viewing trash automatically leaves the trash view.',
  '**Show Trash button** – Aligned with the filter inputs (Start Date, End Date, Customer).',
  '**✓ Submitted button** – Now uses the same blue color as User Approved for consistency.',
];

const V110_REMOVED = [
  '**Workflow progress on trashed tickets** – The workflow steps and "Mark as PDF Exported" section are hidden when viewing a trashed ticket.',
];

const V110_FIXED = [
  '**Right-click on calendar** – Chrome no longer shows its own context menu; right-click no longer opens the edit modal.',
];

// ─── v1.0.0 ───────────────────────────────────────────────────────────────────
const V100_ADDED = [
  '**Trash (formerly Discard)** – Service tickets can be moved to trash (hidden from the main list). A **Show Trash** button reveals them; trashed tickets can be restored individually or in bulk.',
  '**New badge** – Draft tickets created from time entries you haven\'t opened yet show a blue **New** badge. Badge clears after opening the ticket. New tickets sort to the top of Drafts.',
  '**Inactive clients and projects** – Clients and projects are no longer deleted. Admins can **Mark inactive** to hide them. A **Show inactive** toggle (admin only) reveals them for editing or **Reactivate**.',
  '**Project number – admin only** – Only admins can add or edit the Project number (Job ID). Non-admins cannot see or edit it.',
  '**Admin: projects missing project number** – Projects without a project number are highlighted in green. A green dot appears next to **Projects** in the sidebar when any project is missing one.',
  '**Admin: resubmitted tickets** – A yellow dot appears next to **Service Tickets** when there are resubmitted tickets (rejected then resubmitted) in the Submitted tab.',
  '**Rejection notes** – When an admin rejects a ticket, they can enter a reason. The user sees it in a banner when opening the rejected ticket.',
  '**Create service ticket from scratch** – Create a ticket without time entries. Customer and project selection pre-fill address, contact, and related info.',
  '**Inline create Customer and Project** – In the Create Service Ticket panel, add new customers or projects without leaving the form.',
  '**Bulk actions** – Move to Trash, Restore Selected (in trash), Approve, Unapprove. Export PDF and Mark as Submitted removed from bulk bar.',
  '**Service Ticket Status Tabs** – Drafts, Submitted, Approved, All Tickets. Admins default to Submitted; non-admins to Drafts.',
  '**Admin Approve / Reject** – Approve and Reject buttons on submitted tickets. Rejected tickets return to Drafts with a **Rejected** badge and sidebar notification.',
  '**PO/AFE/CC (Cost Center) on time entries** – PO/AFE/CC (Cost Center) field between Location and Rate Type when a customer is selected. Pre-filled from project; saved with the entry.',
  '**"Other" on service ticket PDF** – Other column on the same row as PO/CC/AFE in the exported PDF.',
  '**Payroll for all users** – Payroll available to everyone; non-admins see only their own data.',
];

const V100_CHANGED = [
  '**Trash flow** – Trashing clears ticket number. Restore Selected in trash view. Bulk selection clears when switching tabs or toggling Show Trash.',
  '**Admin Approve / Reject buttons** – Reject on the left (red), Approve on the right (green).',
  '**Approved styling** – Standardized approved states to green (#10b981).',
  '**Sidebar** – Payroll visible to all users below the MANAGE section.',
  '**Service ticket form** – "Project Number" renamed to **Project**.',
  '**Time entry form** – "Different locations create separate service tickets" now appears above the Location input.',
  '**Customers and projects** – Delete removed; **Mark inactive** (admin only).',
  '**Payroll (admin)** – All active employees shown in the period, including those with 0.00 hours.',
  '**Mark client inactive** – All of that client\'s projects are now marked inactive too.',
];

const V100_REMOVED = [
  '**Feedback & Issues page** – Removed from the app and sidebar.',
  '**Bulk Export PDF / Mark as Submitted** – Removed from bulk actions.',
];

const V100_FIXED = [
  '**Service tickets** – Standalone tickets show in the list. Date and employee filters apply. PO/CC/AFE on PDF. Deleting last time entry deletes the ticket. Ghost tickets cleaned up.',
  '**Time entries** – Running timer edit modal no longer causes build error (missing po_afe).',
  '**Expenses** – Delete confirmation removed; deletion immediate.',
  '**Calendar (admin view)** – Current user\'s live timer no longer appears when viewing another user\'s calendar.',
];

// ─── Earlier (pre-v1.0) ───────────────────────────────────────────────────────
const EARLIER_SERVICE_TICKETS = [
  'Save Changes and unsaved-changes confirmation; pending changes highlighted.',
  'Header fields (customer/service info, Service Location, PO/AFE/CC (Cost Center), Approver, Coding, Other) saved in header_overrides.',
  'Expenses can be added/edited/removed with changes applied on Save.',
  'PDF export layout and styling improvements; lock message when editing another user\'s ticket.',
  'Entry-level location and PO/AFE/CC (Cost Center) take priority over project/customer defaults on tickets.',
  'Different locations no longer merge into one ticket; matching includes location.',
  'Non-admin users create draft ticket records (no ticket number) when opening or saving a ticket.',
  'Changelog link under Settings (admin only).',
];

const EARLIER_TIME_ENTRY = [
  'Add Time Entry modal: taller (min 75vh) for better dropdown visibility; scrollable (max height 90vh) on small screens.',
  'Editable hours field in Add Time Entry auto-adjusts end time.',
  'Customer and project required before enabling Add/play; button greyed out until selected.',
  'Location no longer auto-populated from last entry in manual time entry modals.',
  'Header: PO/AFE/CC (Cost Center) field on live timer; project details on second row.',
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

function VersionBlock({ version, date, children }: { version: string; date?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '32px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '12px' }}>
        <h2 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
          {version}
        </h2>
        {date && (
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{date}</span>
        )}
      </div>
      {children}
    </div>
  );
}

export default function Changelog() {
  return (
    <div style={{ padding: '24px', maxWidth: '720px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '28px', fontWeight: '700', marginBottom: '8px', color: 'var(--text-primary)' }}>
        Changelog
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
        Notable changes to IONEX Time Tracking, in plain language.
      </p>

      {/* What's New summary */}
      <div
        style={{
          padding: '16px 20px',
          marginBottom: '32px',
          backgroundColor: 'rgba(37, 99, 235, 0.08)',
          border: '1px solid rgba(37, 99, 235, 0.3)',
          borderRadius: '8px',
        }}
      >
        <h3 style={{ fontSize: '13px', fontWeight: '700', color: 'var(--primary-color)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          What&apos;s New
        </h3>
        <p
          style={{ margin: 0, fontSize: '14px', lineHeight: 1.6, color: 'var(--text-primary)' }}
          dangerouslySetInnerHTML={{
            __html: WHATS_NEW_SUMMARY.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'),
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <VersionBlock version="v1.1.0" date="February 2026">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <Section title="Added">{renderList(V110_ADDED)}</Section>
            <Section title="Changed">{renderList(V110_CHANGED)}</Section>
            <Section title="Removed">{renderList(V110_REMOVED)}</Section>
            <Section title="Fixed">{renderList(V110_FIXED)}</Section>
          </div>
        </VersionBlock>

        <VersionBlock version="v1.0.0" date="January 2026">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <Section title="Added">{renderList(V100_ADDED)}</Section>
            <Section title="Changed">{renderList(V100_CHANGED)}</Section>
            <Section title="Removed">{renderList(V100_REMOVED)}</Section>
            <Section title="Fixed">{renderList(V100_FIXED)}</Section>
          </div>
        </VersionBlock>

        <VersionBlock version="Earlier improvements">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <Section title="Service tickets">{renderList(EARLIER_SERVICE_TICKETS)}</Section>
            <Section title="Time entry & calendar">{renderList(EARLIER_TIME_ENTRY)}</Section>
            <Section title="Payroll / Week view">{renderList(EARLIER_PAYROLL)}</Section>
            <Section title="General">{renderList(EARLIER_GENERAL)}</Section>
          </div>
        </VersionBlock>
      </div>
    </div>
  );
}
