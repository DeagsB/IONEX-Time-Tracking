import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoiceWorkflowsService, type InvoiceWorkflowStatus, type InvoiceWorkflowRow } from '../services/supabaseServices';

const STATUS_COLORS = [
  { value: 'gray', label: 'Gray', hex: '#6b7280' },
  { value: 'blue', label: 'Blue', hex: '#3b82f6' },
  { value: 'orange', label: 'Orange', hex: '#f59e0b' },
  { value: 'green', label: 'Green', hex: '#22c55e' },
  { value: 'red', label: 'Red', hex: '#ef4444' },
  { value: 'purple', label: 'Purple', hex: '#8b5cf6' },
  { value: 'teal', label: 'Teal', hex: '#14b8a6' },
];

function colorHex(name: string) {
  return STATUS_COLORS.find((c) => c.value === name)?.hex ?? '#6b7280';
}

function generateId() {
  return crypto.randomUUID?.() ?? `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyStatus(): InvoiceWorkflowStatus {
  return { id: generateId(), label: '', color: 'gray' };
}

export default function InvoiceWorkflows() {
  const queryClient = useQueryClient();
  const { data: workflows = [], isLoading } = useQuery({
    queryKey: ['invoiceWorkflows'],
    queryFn: invoiceWorkflowsService.getAll,
  });

  const [editing, setEditing] = useState<InvoiceWorkflowRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [formName, setFormName] = useState('');
  const [formStatuses, setFormStatuses] = useState<InvoiceWorkflowStatus[]>([]);
  const [formDefault, setFormDefault] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['invoiceWorkflows'] });

  const createMutation = useMutation({
    mutationFn: invoiceWorkflowsService.create,
    onSuccess: () => { invalidate(); resetForm(); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...rest }: { id: string; name: string; statuses: InvoiceWorkflowStatus[]; is_default: boolean }) =>
      invoiceWorkflowsService.update(id, rest),
    onSuccess: () => { invalidate(); resetForm(); },
  });

  const deleteMutation = useMutation({
    mutationFn: invoiceWorkflowsService.delete,
    onSuccess: () => { invalidate(); setDeleteConfirm(null); },
  });

  const resetForm = () => {
    setEditing(null);
    setCreating(false);
    setFormName('');
    setFormStatuses([]);
    setFormDefault(false);
  };

  const startCreate = () => {
    resetForm();
    setCreating(true);
    setFormStatuses([emptyStatus()]);
  };

  const startEdit = (wf: InvoiceWorkflowRow) => {
    setCreating(false);
    setEditing(wf);
    setFormName(wf.name);
    setFormStatuses(wf.statuses.map((s) => ({ ...s })));
    setFormDefault(wf.is_default);
  };

  const addStatus = () => setFormStatuses((prev) => [...prev, emptyStatus()]);

  const removeStatus = (idx: number) =>
    setFormStatuses((prev) => prev.filter((_, i) => i !== idx));

  const updateStatusField = (idx: number, field: keyof InvoiceWorkflowStatus, val: string) =>
    setFormStatuses((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: val } : s)));

  const moveStatus = (from: number, to: number) => {
    if (to < 0 || to >= formStatuses.length) return;
    setFormStatuses((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const handleSave = () => {
    const trimmed = formName.trim();
    if (!trimmed) return;
    const validStatuses = formStatuses.filter((s) => s.label.trim());
    if (validStatuses.length === 0) return;
    if (editing) {
      updateMutation.mutate({ id: editing.id, name: trimmed, statuses: validStatuses, is_default: formDefault });
    } else {
      createMutation.mutate({ name: trimmed, statuses: validStatuses, is_default: formDefault });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isFormOpen = creating || !!editing;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
        <h2>Invoice Workflows</h2>
        {!isFormOpen && (
          <button className="button button-primary" onClick={startCreate}>
            New Workflow
          </button>
        )}
      </div>

      {isFormOpen && (
        <div className="card" style={{ marginBottom: '24px' }}>
          <h3 style={{ marginBottom: '16px' }}>{editing ? 'Edit Workflow' : 'New Workflow'}</h3>

          <div className="form-group">
            <label className="label">Workflow Name *</label>
            <input
              type="text"
              className="input"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Standard, Portal Approval"
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '14px', marginBottom: '16px' }}>
            <input
              type="checkbox"
              checked={formDefault}
              onChange={(e) => setFormDefault(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#4ecdc4' }}
            />
            <span>Set as default workflow</span>
          </label>

          <div style={{ marginBottom: '12px' }}>
            <label className="label" style={{ marginBottom: '8px' }}>Statuses (in order)</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {formStatuses.map((s, idx) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => moveStatus(idx, idx - 1)}
                      disabled={idx === 0}
                      style={{
                        border: 'none',
                        background: 'none',
                        cursor: idx === 0 ? 'default' : 'pointer',
                        opacity: idx === 0 ? 0.25 : 0.6,
                        fontSize: '10px',
                        padding: '0 4px',
                        lineHeight: 1,
                        color: 'var(--text-secondary)',
                      }}
                      title="Move up"
                    >▲</button>
                    <button
                      type="button"
                      onClick={() => moveStatus(idx, idx + 1)}
                      disabled={idx === formStatuses.length - 1}
                      style={{
                        border: 'none',
                        background: 'none',
                        cursor: idx === formStatuses.length - 1 ? 'default' : 'pointer',
                        opacity: idx === formStatuses.length - 1 ? 0.25 : 0.6,
                        fontSize: '10px',
                        padding: '0 4px',
                        lineHeight: 1,
                        color: 'var(--text-secondary)',
                      }}
                      title="Move down"
                    >▼</button>
                  </div>

                  <span style={{
                    width: '24px',
                    height: '24px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'var(--bg-tertiary)',
                    borderRadius: '50%',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: 'var(--text-tertiary)',
                    flexShrink: 0,
                  }}>{idx + 1}</span>

                  <input
                    type="text"
                    className="input"
                    style={{ flex: 1 }}
                    value={s.label}
                    onChange={(e) => updateStatusField(idx, 'label', e.target.value)}
                    placeholder="Status label"
                  />

                  <select
                    className="input"
                    style={{ width: '110px', flexShrink: 0 }}
                    value={s.color}
                    onChange={(e) => updateStatusField(idx, 'color', e.target.value)}
                  >
                    {STATUS_COLORS.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>

                  <span style={{
                    width: '14px',
                    height: '14px',
                    borderRadius: '50%',
                    backgroundColor: colorHex(s.color),
                    flexShrink: 0,
                    border: '1px solid rgba(0,0,0,0.1)',
                  }} />

                  <button
                    type="button"
                    onClick={() => removeStatus(idx)}
                    disabled={formStatuses.length <= 1}
                    style={{
                      border: 'none',
                      background: 'none',
                      cursor: formStatuses.length <= 1 ? 'default' : 'pointer',
                      color: formStatuses.length <= 1 ? 'var(--text-tertiary)' : '#ef4444',
                      fontSize: '16px',
                      fontWeight: 700,
                      padding: '0 4px',
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                    title="Remove status"
                  >×</button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="button button-secondary"
              onClick={addStatus}
              style={{ marginTop: '8px', fontSize: '13px', padding: '6px 14px' }}
            >
              + Add Status
            </button>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
            <button
              type="button"
              className="button button-primary"
              onClick={handleSave}
              disabled={isSaving || !formName.trim() || formStatuses.filter((s) => s.label.trim()).length === 0}
            >
              {isSaving ? 'Saving…' : editing ? 'Update Workflow' : 'Create Workflow'}
            </button>
            <button type="button" className="button button-secondary" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>
      ) : workflows.length === 0 && !isFormOpen ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 20px' }}>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '12px' }}>No workflows yet.</p>
          <button className="button button-primary" onClick={startCreate}>Create your first workflow</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {workflows.map((wf) => (
            <div
              key={wf.id}
              className="card"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px',
                flexWrap: 'wrap',
                cursor: 'pointer',
                transition: 'box-shadow 0.15s ease',
              }}
              onClick={() => startEdit(wf)}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 0 2px var(--primary-color)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = ''; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', minWidth: 0 }}>
                <span style={{ fontWeight: 700, fontSize: '15px' }}>{wf.name}</span>
                {wf.is_default && (
                  <span style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: '999px',
                    backgroundColor: 'var(--primary-light)',
                    color: 'var(--primary-color)',
                  }}>
                    Default
                  </span>
                )}
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {wf.statuses.map((s, i) => (
                    <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      {i > 0 && <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>→</span>}
                      <span
                        style={{
                          fontSize: '12px',
                          fontWeight: 500,
                          padding: '2px 10px',
                          borderRadius: '999px',
                          backgroundColor: `${colorHex(s.color)}18`,
                          color: colorHex(s.color),
                          border: `1px solid ${colorHex(s.color)}40`,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {s.label}
                      </span>
                    </span>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ fontSize: '12px', padding: '5px 12px' }}
                  onClick={() => startEdit(wf)}
                >
                  Edit
                </button>
                {deleteConfirm === wf.id ? (
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      type="button"
                      style={{
                        padding: '5px 12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        borderRadius: '6px',
                        border: 'none',
                        backgroundColor: '#ef4444',
                        color: '#fff',
                        cursor: 'pointer',
                      }}
                      onClick={() => deleteMutation.mutate(wf.id)}
                      disabled={deleteMutation.isPending}
                    >
                      {deleteMutation.isPending ? 'Deleting…' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      style={{ fontSize: '12px', padding: '5px 12px' }}
                      onClick={() => setDeleteConfirm(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={{
                      padding: '5px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      borderRadius: '6px',
                      border: '1px solid var(--border-color)',
                      backgroundColor: 'var(--bg-tertiary)',
                      color: '#ef4444',
                      cursor: 'pointer',
                    }}
                    onClick={() => setDeleteConfirm(wf.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
