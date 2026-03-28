import { useState, type CSSProperties } from 'react';

type Variant = 'employee' | 'profitability';

const panelStyle: CSSProperties = {
  marginBottom: '20px',
  border: '1px solid var(--border-color)',
  borderRadius: '10px',
  backgroundColor: 'var(--bg-secondary)',
  overflow: 'hidden',
};

const listStyle: CSSProperties = {
  margin: '0 0 0 1.1em',
  padding: 0,
  fontSize: '13px',
  color: 'var(--text-secondary)',
  lineHeight: 1.55,
};

const liStyle: CSSProperties = { marginBottom: '6px' };

export function ReportMethodologyCollapsible({ variant }: { variant: Variant }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={panelStyle}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 16px',
          border: 'none',
          background: open ? 'var(--bg-tertiary)' : 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: '13px',
          fontWeight: '600',
          color: 'var(--text-primary)',
        }}
      >
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          &#9654;
        </span>
        How revenue and cost are calculated
      </button>
      {open && (
        <div
          style={{
            padding: '0 16px 16px 38px',
            borderTop: '1px solid var(--border-color)',
            paddingTop: '14px',
          }}
        >
          {variant === 'employee' ? <EmployeeBody /> : <ProfitabilityBody />}
        </div>
      )}
    </div>
  );
}

function EmployeeBody() {
  return (
    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
      <p style={{ margin: '0 0 10px', color: 'var(--text-primary)', fontWeight: '600' }}>Per employee (and summary totals)</p>
      <ul style={listStyle}>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Revenue</strong> — Labor: sum of <em>approved / exported</em> service ticket{' '}
          <code style={{ fontSize: '12px' }}>total_amount</code> for that employee. Plus customer-billed amounts on ticket expense lines (quantity × rate).{' '}
          With <strong>Include GST</strong>, 5% is applied to those billable totals (not to payroll cost).
        </li>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Labor cost</strong> — From the rate-type breakdown: loaded pay rates (including burden) × hours from{' '}
          <em>all</em> time entries for that person (shop/field/travel/OT and non-billable/internal, including unbilled vs ticket gaps). This is full payroll-style cost for time on the calendar.
        </li>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Expense cost</strong> — Ticket expenses on that employee&apos;s tickets: reimbursable lines use reimbursement rules (rates on the employee); billed-only lines use{' '}
          <em>Actual cost</em> when set, otherwise rules such as pass-through billed amount for parts/equipment (see expense rows in the detail modal).
        </li>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Total cost</strong> — Labor cost + expense cost.
        </li>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Net profit &amp; margin</strong> — Revenue − total cost. Summary cards use total revenue minus total cost (rounded to cents) so they match the Revenue and Total Cost cards.
        </li>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Hours &amp; billable %</strong> — Total hours are billable + non-billable from entries; billable % uses ticket-linked billable hours vs total hours.
        </li>
      </ul>
      <p style={{ margin: '12px 0 0', fontSize: '12px', color: 'var(--text-tertiary)' }}>
        <strong style={{ color: 'var(--text-secondary)' }}>vs Project Profitability:</strong> This page includes labor for time logged <em>without a project</em> (internal, overhead, etc.). The project page only counts labor on entries tied to a project, so total cost and profit can differ even when revenue lines up.
      </p>
    </div>
  );
}

function ProfitabilityBody() {
  return (
    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
      <p style={{ margin: '0 0 10px', color: 'var(--text-primary)', fontWeight: '600' }}>Per project row</p>
      <ul style={listStyle}>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Revenue</strong> — Labor: sum of <em>approved / exported</em> service ticket{' '}
          <code style={{ fontSize: '12px' }}>total_amount</code> for tickets on that project. Plus customer-billed ticket expense lines (qty × rate) on those tickets.{' '}
          <strong>Include GST</strong> adds 5% to those combined billable amounts.
        </li>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Labor cost</strong> — Only time entries with this <em>project</em> selected: hours × loaded pay rate (with burden) by rate type. Entries with no project do not roll into any project row.
        </li>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Expense cost</strong> — Same ticket expense lines counted in revenue, using company/reimbursement cost rules (aligned with Employee Reports expense logic).
        </li>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Profit &amp; margin</strong> — Project revenue − project total cost; margin is profit ÷ revenue.
        </li>
        <li style={liStyle}>
          Tickets in <strong>draft, submitted, or rejected</strong> are excluded from these revenue and cost totals (they may appear marked in detail for reference). Discarded tickets are excluded from expense rollups.
        </li>
      </ul>
      <p style={{ margin: '12px 0 0', color: 'var(--text-primary)', fontWeight: '600' }}>Summary cards (top)</p>
      <ul style={{ ...listStyle, marginTop: '8px' }}>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Total Revenue / Cost / Profit</strong> — Sum of the <em>visible</em> project rows (respects search and inactive filter). Total profit is revenue minus cost, rounded to cents.
        </li>
        <li style={liStyle}>
          <strong style={{ color: 'var(--text-primary)' }}>Hours</strong> — Sum of time entry hours allocated to those projects only.
        </li>
      </ul>
      <p style={{ margin: '12px 0 0', fontSize: '12px', color: 'var(--text-tertiary)' }}>
        <strong style={{ color: 'var(--text-secondary)' }}>vs Employee Reports:</strong> Project view omits labor that is not booked to a project, so company-wide cost is usually lower here than on employee rollups when people log internal or non-project time.
      </p>
    </div>
  );
}
