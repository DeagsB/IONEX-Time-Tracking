import { useEffect, useRef, useState } from 'react';

const KEYFRAMES_ID = 'ionex-toast-keyframes';

/** One-time injected stylesheet — registers the slide-in / slide-out animations. */
function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const el = document.createElement('style');
  el.id = KEYFRAMES_ID;
  el.textContent = `
    @keyframes ionex-toast-slide-in-up {
      from { transform: translateY(120%); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }
    @keyframes ionex-toast-slide-out-down {
      from { transform: translateY(0);    opacity: 1; }
      to   { transform: translateY(120%); opacity: 0; }
    }
    @keyframes ionex-toast-slide-in-down {
      from { transform: translateY(-120%); opacity: 0; }
      to   { transform: translateY(0);     opacity: 1; }
    }
    @keyframes ionex-toast-slide-out-up {
      from { transform: translateY(0);     opacity: 1; }
      to   { transform: translateY(-120%); opacity: 0; }
    }
  `;
  document.head.appendChild(el);
}

export type ToastVariant = 'error' | 'warning' | 'success' | 'info';
export type ToastPosition = 'bottom-right' | 'bottom-center' | 'top-right' | 'top-center';

const VARIANT_COLORS: Record<ToastVariant, { bg: string; border: string; text: string }> = {
  error:   { bg: 'rgba(239, 83, 80, 0.96)',  border: '#ef5350', text: '#ffffff' },
  warning: { bg: 'rgba(245, 158, 11, 0.96)', border: '#b45309', text: '#ffffff' },
  success: { bg: 'rgba(34, 197, 94, 0.96)',  border: '#15803d', text: '#ffffff' },
  info:    { bg: 'rgba(59, 130, 246, 0.96)', border: '#2563eb', text: '#ffffff' },
};

interface ToastProps {
  /** When non-null the toast is shown. Set to null to dismiss programmatically. */
  message: string | null;
  onDismiss: () => void;
  variant?: ToastVariant;
  /** Milliseconds visible before auto-dismiss. Default 6000. Pass 0 to disable auto-dismiss. */
  durationMs?: number;
  position?: ToastPosition;
  /** Optional inline action (e.g. Undo). Clicking it calls onClick then dismisses the toast. */
  action?: { label: string; onClick: () => void };
}

export function Toast({ message, onDismiss, variant = 'error', durationMs = 6000, position = 'bottom-right', action }: ToastProps) {
  const [phase, setPhase] = useState<'hidden' | 'in' | 'out'>('hidden');
  const [renderedMessage, setRenderedMessage] = useState<string | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { ensureKeyframes(); }, []);

  // React to incoming message changes — drive the phase state machine.
  useEffect(() => {
    if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; }
    if (removeTimer.current)  { clearTimeout(removeTimer.current);  removeTimer.current  = null; }

    if (message) {
      setRenderedMessage(message);
      setPhase('in');
      if (durationMs > 0) {
        dismissTimer.current = setTimeout(() => {
          setPhase('out');
          removeTimer.current = setTimeout(() => {
            setPhase('hidden');
            onDismiss();
          }, 350);
        }, durationMs);
      }
    } else if (phase === 'in') {
      // Programmatic dismiss while showing — run the exit animation.
      setPhase('out');
      removeTimer.current = setTimeout(() => {
        setPhase('hidden');
      }, 350);
    }
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      if (removeTimer.current)  clearTimeout(removeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, durationMs]);

  if (phase === 'hidden' || !renderedMessage) return null;

  const fromBottom = position.startsWith('bottom');
  const isCenter   = position.endsWith('center');
  const enterAnim  = fromBottom ? 'ionex-toast-slide-in-up'   : 'ionex-toast-slide-in-down';
  const exitAnim   = fromBottom ? 'ionex-toast-slide-out-down' : 'ionex-toast-slide-out-up';

  const colors = VARIANT_COLORS[variant];

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        zIndex: 9000,
        [fromBottom ? 'bottom' : 'top']: '24px',
        ...(isCenter
          ? { left: '50%', transform: 'translateX(-50%)' } as const
          : { right: '24px' } as const),
        maxWidth: 'min(440px, calc(100vw - 48px))',
        padding: '12px 14px',
        backgroundColor: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        boxShadow: '0 12px 30px rgba(0, 0, 0, 0.25)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        fontSize: '13px',
        lineHeight: 1.45,
        animation: `${phase === 'in' ? enterAnim : exitAnim} 0.32s ${phase === 'in' ? 'ease-out' : 'ease-in'} forwards`,
      }}
    >
      <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderedMessage}</span>
      {action && (
        <button
          type="button"
          onClick={() => {
            if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; }
            action.onClick();
            setPhase('out');
            removeTimer.current = setTimeout(() => {
              setPhase('hidden');
              onDismiss();
            }, 320);
          }}
          style={{
            flexShrink: 0,
            border: `1px solid ${colors.text}`,
            backgroundColor: 'transparent',
            color: colors.text,
            fontSize: '12px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            cursor: 'pointer',
            padding: '4px 10px',
            borderRadius: '6px',
            lineHeight: 1.2,
            fontFamily: 'inherit',
          }}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; }
          setPhase('out');
          removeTimer.current = setTimeout(() => {
            setPhase('hidden');
            onDismiss();
          }, 320);
        }}
        aria-label="Dismiss"
        style={{
          flexShrink: 0,
          border: 'none',
          background: 'transparent',
          color: colors.text,
          fontSize: '16px',
          fontWeight: 700,
          cursor: 'pointer',
          padding: '0 4px',
          lineHeight: 1,
          opacity: 0.85,
        }}
      >
        ✕
      </button>
    </div>
  );
}

export default Toast;
