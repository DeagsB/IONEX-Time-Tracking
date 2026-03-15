import React, { useState, useEffect } from 'react';

// ────────────────────────────────────────────────────────────────────────────
// Bump this key every time you add a new "What's New" release.
// The modal will re-appear for all users when this changes.
// ────────────────────────────────────────────────────────────────────────────
const WHATS_NEW_VERSION = '2026-02-21-v1.3.0';

const STORAGE_KEY = 'ionex_whats_new_dismissed';

interface WhatsNewEntry {
  title: string;
  items: string[];
}

const entries: WhatsNewEntry[] = [
  {
    title: 'Expenses',
    items: [
      '**Expenses page** is now available to all users — submit receipts, track reimbursements, and apply expenses to service tickets.',
      'You can **unapply an expense** from a service ticket directly from the Edit Expense modal.',
      'Approved expenses are **automatically included in your next pay run** as reimbursements.',
    ],
  },
  {
    title: 'Service Tickets',
    items: [
      '**See Details** when applying an expense to a ticket — view time entries and expenses on each ticket before choosing.',
      '**Right-click to delete** time entries on the calendar week view.',
    ],
  },
];

function bold(text: string) {
  return text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

export default function WhatsNewModal() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (dismissed !== WHATS_NEW_VERSION) {
      setVisible(true);
    }
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, WHATS_NEW_VERSION);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 20000,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 200ms ease',
      }}
      onClick={handleDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '14px',
          padding: '0',
          maxWidth: '520px',
          width: '92%',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 80px rgba(0,0,0,0.35)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--border-color)',
            background: 'linear-gradient(135deg, rgba(37,99,235,0.08) 0%, rgba(37,99,235,0.02) 100%)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '22px' }}>&#9889;</span>
              <h2 style={{ margin: 0, fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)' }}>
                What&apos;s New
              </h2>
            </div>
            <button
              onClick={handleDismiss}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '22px',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                padding: '4px 8px',
                lineHeight: 1,
              }}
            >
              &times;
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          {entries.map((section, i) => (
            <div key={i} style={{ marginBottom: i < entries.length - 1 ? '20px' : 0 }}>
              <h3
                style={{
                  fontSize: '14px',
                  fontWeight: '700',
                  color: 'var(--primary-color)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.4px',
                  marginBottom: '10px',
                  margin: '0 0 10px 0',
                }}
              >
                {section.title}
              </h3>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: '18px',
                  fontSize: '13.5px',
                  lineHeight: 1.65,
                  color: 'var(--text-primary)',
                }}
              >
                {section.items.map((item, j) => (
                  <li key={j} style={{ marginBottom: '6px' }}>
                    <span dangerouslySetInnerHTML={{ __html: bold(item) }} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-color)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={handleDismiss}
            style={{
              padding: '8px 22px',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: 'var(--primary-color)',
              color: 'white',
              fontSize: '13px',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
