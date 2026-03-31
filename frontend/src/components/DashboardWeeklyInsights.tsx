import { useNavigate } from 'react-router-dom';
import type { DashboardInsight } from '../utils/dashboardWeeklyInsights';

const toneBorder: Record<DashboardInsight['tone'], string> = {
  attention: '#ef4444',
  positive: '#10b981',
  neutral: 'var(--border-color)',
};

const toneBg: Record<DashboardInsight['tone'], string> = {
  attention: 'rgba(239, 68, 68, 0.06)',
  positive: 'rgba(16, 185, 129, 0.08)',
  neutral: 'var(--bg-secondary)',
};

function groupByTone(insights: DashboardInsight[]) {
  return {
    attention: insights.filter((i) => i.tone === 'attention'),
    positive: insights.filter((i) => i.tone === 'positive'),
    neutral: insights.filter((i) => i.tone === 'neutral'),
  };
}

function InsightCard({
  row,
  onNavigate,
}: {
  row: DashboardInsight;
  onNavigate: (path: string) => void;
}) {
  return (
    <div
      style={{
        borderRadius: 10,
        border: '1px solid var(--border-color)',
        borderLeftWidth: 4,
        borderLeftColor: toneBorder[row.tone],
        backgroundColor: toneBg[row.tone],
        padding: '12px 14px',
        transition: 'box-shadow 0.15s',
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-primary)',
          marginBottom: 6,
          lineHeight: 1.35,
        }}
      >
        {row.title}
      </div>
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
        {row.detail}
      </p>
      {row.actionPath && row.actionLabel && (
        <button
          type="button"
          onClick={() => onNavigate(row.actionPath!)}
          style={{
            marginTop: 10,
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 8,
            border: '1px solid var(--border-color)',
            backgroundColor: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
          }}
        >
          {row.actionLabel} →
        </button>
      )}
    </div>
  );
}

export default function DashboardWeeklyInsights({ insights }: { insights: DashboardInsight[] }) {
  const navigate = useNavigate();
  const { attention, positive, neutral } = groupByTone(insights);

  if (insights.length === 0) {
    return (
      <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
        Load ticket and time data to see weekly insights.
      </p>
    );
  }

  const section = (title: string, subtitle: string, rows: DashboardInsight[], marginTop: number) =>
    rows.length === 0 ? null : (
      <div style={{ marginTop }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
            marginBottom: 8,
          }}
        >
          {title}
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          {subtitle}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((row) => (
            <InsightCard key={row.id} row={row} onNavigate={navigate} />
          ))}
        </div>
      </div>
    );

  return (
    <div
      style={{
        maxHeight: 420,
        overflowY: 'auto',
        paddingRight: 4,
      }}
    >
      {section(
        'Needs attention',
        'Queues, margin pressure, or data gaps worth acting on this week.',
        attention,
        0,
      )}
      {section(
        "What's going well",
        'Revenue momentum, healthy WIP, or strong utilization.',
        positive,
        attention.length ? 18 : 0,
      )}
      {section(
        'Context & snapshot',
        'Week-over-week movement and reference numbers (not necessarily problems).',
        neutral,
        attention.length || positive.length ? 18 : 0,
      )}
    </div>
  );
}
