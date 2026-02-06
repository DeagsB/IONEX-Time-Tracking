
const CHANGELOG_ENTRIES = [
  {
    version: '1.2.0',
    date: '2026-01-30',
    changes: [
      '**Manual Add Time Entry:** Progressive form – only Time and Customer show first; after selecting a customer, Project appears; after selecting a project, Location, PO/AFE, Rate type, and Description are shown.',
      '**IONEX Systems:** When IONEX Systems is selected as the customer, rate type defaults to Internal (and pay is non-billable) in both Add and Edit time entry modals.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-01-30',
    changes: [
      '**Live timer & manual time entry:** Add/play button is now disabled until both customer and project are selected. IONEX Systems can be used as the internal hours selection.',
      '**Service tickets – location-aware:** Entries with different work locations on the same day now create separate service tickets instead of merging. Service location and PO/AFE from each entry are preserved and no longer overwritten by a single ticket.',
      '**Service tickets – Brooks District fix:** Resolved issue where tickets were hidden when stale discarded records existed for the same date/customer/user. Computed tickets with time entries now always appear in the main view.',
      '**Location field:** Stopped auto-populating location from the last used value when selecting a project (live timer header and Add/Edit Time Entry modals). Location now uses only the project default when set.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-01',
    changes: [
      'Initial release of IONEX Time Tracking.',
      'Timer (week/calendar view), manual time entries, projects, clients, service tickets.',
      'Payroll, employee reports, user management (admin).',
      'Profile settings, theme toggle, demo mode.',
    ],
  },
];

export default function Changelog() {
  return (
    <div style={{ padding: '24px', maxWidth: '720px', margin: '0 auto' }}>
      <h1 style={{
        fontSize: '28px',
        fontWeight: '700',
        marginBottom: '8px',
        color: 'var(--text-primary)',
      }}>
        Changelog
      </h1>
      <p style={{
        fontSize: '14px',
        color: 'var(--text-secondary)',
        marginBottom: '32px',
      }}>
        Recent updates and improvements to IONEX Time Tracking.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
        {CHANGELOG_ENTRIES.map((entry) => (
          <section
            key={entry.version}
            style={{
              padding: '20px 24px',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '12px',
              marginBottom: '16px',
              flexWrap: 'wrap',
            }}>
              <span style={{
                fontSize: '18px',
                fontWeight: '700',
                color: 'var(--text-primary)',
              }}>
                v{entry.version}
              </span>
              <span style={{
                fontSize: '13px',
                color: 'var(--text-tertiary)',
              }}>
                {entry.date}
              </span>
            </div>
            <ul style={{
              margin: 0,
              paddingLeft: '20px',
              color: 'var(--text-primary)',
              fontSize: '14px',
              lineHeight: 1.6,
            }}>
              {entry.changes.map((item, i) => (
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
          </section>
        ))}
      </div>
    </div>
  );
}
