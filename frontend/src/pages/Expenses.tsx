import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { userExpensesService, serviceTicketExpensesService } from '../services/supabaseServices';
import { supabase } from '../lib/supabaseClient';
import { optimizeImage } from '../utils/imageOptimizer';
import { useAuth } from '../context/AuthContext';
import { useDemoMode } from '../context/DemoModeContext';

interface ReceiptFormState {
  description: string;
  amount: string;
  gst: string;
  is_billable: boolean;
  expense_date: string;
  notes: string;
}

const initialReceiptForm: ReceiptFormState = {
  description: '',
  amount: '',
  gst: '',
  is_billable: false,
  expense_date: new Date().toISOString().split('T')[0],
  notes: '',
};

export default function Expenses() {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const { isDemoMode } = useDemoMode();

  // Receipt drag-and-drop + split view state
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string | null>(null);
  const [receiptForm, setReceiptForm] = useState<ReceiptFormState>(initialReceiptForm);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // "Apply to Ticket" modal state
  const [applyExpenseId, setApplyExpenseId] = useState<string | null>(null);
  const [showTicketPickerModal, setShowTicketPickerModal] = useState(false);
  const [ticketSearchQuery, setTicketSearchQuery] = useState('');

  // Viewing receipt
  const [viewingReceiptUrl, setViewingReceiptUrl] = useState<string | null>(null);
  const [viewingReceiptIsPdf, setViewingReceiptIsPdf] = useState(false);
  const [loadingReceiptId, setLoadingReceiptId] = useState<string | null>(null);

  // Admin approval
  const [adminStatusFilter, setAdminStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'paid' | 'all'>('pending');
  const [updatingExpenseId, setUpdatingExpenseId] = useState<string | null>(null);

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['userExpenses'],
    queryFn: () => userExpensesService.getAll(),
  });

  const { data: allTicketRecords = [] } = useQuery({
    queryKey: ['ticketsForExpensePicker', isDemoMode],
    queryFn: async () => {
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
      const { data, error } = await supabase
        .from(tableName)
        .select('id, ticket_number, date, location, workflow_status, user_id')
        .order('date', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data || [];
    },
    enabled: showTicketPickerModal,
  });

  // Filter to un-invoiced tickets (draft/approved, not yet sent for invoicing)
  const uninvoicedTickets = allTicketRecords.filter((t: any) => {
    const status = t.workflow_status || 'draft';
    return !['qbo_created', 'sent_to_cnrl', 'cnrl_approved', 'submitted_to_cnrl'].includes(status);
  });

  const filteredPickerTickets = uninvoicedTickets.filter((t: any) => {
    if (!ticketSearchQuery.trim()) return true;
    const q = ticketSearchQuery.toLowerCase();
    return (
      (t.ticket_number || '').toLowerCase().includes(q) ||
      (t.location || '').toLowerCase().includes(q)
    );
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: (id: string) => userExpensesService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
    },
  });

  const handleAdminStatusChange = async (expenseId: string, newStatus: 'approved' | 'rejected' | 'paid') => {
    setUpdatingExpenseId(expenseId);
    try {
      await userExpensesService.update(expenseId, { status: newStatus });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
    } catch (err: any) {
      alert('Failed to update status: ' + (err.message || 'Unknown error'));
    } finally {
      setUpdatingExpenseId(null);
    }
  };

  const adminFilteredExpenses = expenses.filter((exp: any) => {
    if (adminStatusFilter === 'all') return true;
    return exp.status === adminStatusFilter;
  });

  const handleFileDrop = (file: File) => {
    setReceiptFile(file);
    setReceiptForm(initialReceiptForm);
    setUploadError(null);
    const reader = new FileReader();
    reader.onloadend = () => {
      setReceiptPreviewUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleSubmitReceipt = async () => {
    if (!receiptForm.description.trim()) { setUploadError('Name / description is required'); return; }
    if (!receiptForm.amount || parseFloat(receiptForm.amount) <= 0) { setUploadError('Amount must be greater than 0'); return; }
    setIsUploading(true);
    setUploadError(null);
    try {
      let storagePath: string | undefined;
      if (receiptFile) {
        const optimized = await optimizeImage(receiptFile, { maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
        storagePath = await userExpensesService.uploadReceipt(optimized);
      }
      await userExpensesService.create({
        description: receiptForm.description.trim(),
        amount: parseFloat(receiptForm.amount),
        expense_date: receiptForm.expense_date,
        receipt_url: storagePath,
        gst: parseFloat(receiptForm.gst) || 0,
        is_billable: receiptForm.is_billable,
        notes: receiptForm.notes.trim() || undefined,
        status: 'pending',
      });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      setReceiptFile(null);
      setReceiptPreviewUrl(null);
      setReceiptForm(initialReceiptForm);
    } catch (err: any) {
      setUploadError(err.message || 'Failed to save expense');
    } finally {
      setIsUploading(false);
    }
  };

  const handleApplyToTicket = async (ticketRecordId: string, ticketNumber: string) => {
    if (!applyExpenseId) return;
    const expense = expenses.find((e: any) => e.id === applyExpenseId);
    if (!expense) return;

    const markupStr = prompt('Enter markup (e.g. 10 for $10, 10% for percentage, or 0 for none):') || '0';
    let markup = 0;
    const expAmt = parseFloat(expense.amount);
    if (markupStr.includes('%')) {
      const pct = parseFloat(markupStr.replace('%', ''));
      markup = (expAmt * pct) / 100;
    } else {
      markup = parseFloat(markupStr) || 0;
    }
    const totalWithMarkup = expAmt + markup;

    try {
      await userExpensesService.update(applyExpenseId, {
        service_ticket_id: ticketRecordId,
        markup_amount: markup,
      });
      await serviceTicketExpensesService.create({
        service_ticket_id: ticketRecordId,
        expense_type: 'Expenses',
        description: expense.description,
        quantity: 1,
        rate: totalWithMarkup,
        unit: '',
      });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      setShowTicketPickerModal(false);
      setApplyExpenseId(null);
    } catch (err: any) {
      alert('Failed to apply expense to ticket: ' + (err.message || 'Unknown error'));
    }
  };

  const handleViewReceipt = async (expense: any) => {
    if (!expense.receipt_url) return;
    setLoadingReceiptId(expense.id);
    const isPdf = (expense.receipt_url || '').toLowerCase().endsWith('.pdf');
    setViewingReceiptIsPdf(isPdf);
    try {
      const signedUrl = await userExpensesService.getReceiptSignedUrl(expense.receipt_url);
      setViewingReceiptUrl(signedUrl);
    } catch {
      setViewingReceiptUrl(expense.receipt_url);
    } finally {
      setLoadingReceiptId(null);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid var(--border-color)',
    backgroundColor: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: '14px',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '12px',
    fontWeight: '600',
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '4px',
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 24px', color: 'var(--text-primary)' }}>
        Internal Expenses & Receipts
      </h1>

      {/* Drag and Drop Zone */}
      <input
        type="file"
        accept="image/*,.pdf"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileDrop(file);
          e.target.value = '';
        }}
      />
      {!receiptPreviewUrl && (
        <div
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsDragOver(false); }}
          onDrop={(e) => {
            e.preventDefault(); e.stopPropagation();
            setIsDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFileDrop(file);
          }}
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: '40px 24px',
            borderRadius: '10px',
            border: `2px dashed ${isDragOver ? 'var(--primary-color)' : 'var(--border-color)'}`,
            backgroundColor: isDragOver ? 'rgba(33, 150, 243, 0.04)' : 'var(--bg-tertiary)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-tertiary)',
            fontSize: '15px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'border-color 0.2s, background-color 0.2s',
            marginBottom: '24px',
          }}
        >
          <div style={{ fontSize: '32px', marginBottom: '8px', opacity: 0.5 }}>&#128206;</div>
          <div style={{ fontWeight: '600', color: 'var(--text-secondary)' }}>Drop a receipt here, or click to upload</div>
          <div style={{ fontSize: '12px', marginTop: '4px' }}>Supports images and PDFs</div>
        </div>
      )}

      {/* Split View: Receipt Preview + Form */}
      {receiptPreviewUrl && (
        <div style={{
          display: 'flex',
          gap: '20px',
          marginBottom: '24px',
          backgroundColor: 'var(--bg-primary)',
          borderRadius: '10px',
          border: '1px solid var(--border-color)',
          overflow: 'hidden',
          minHeight: '400px',
        }}>
          {/* Left: Receipt Preview */}
          <div style={{
            flex: 1,
            backgroundColor: 'var(--bg-tertiary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            overflow: 'auto',
          }}>
            {receiptFile && receiptFile.type === 'application/pdf' ? (
              <iframe
                src={receiptPreviewUrl!}
                title="PDF receipt preview"
                style={{ width: '100%', height: '100%', minHeight: '380px', border: 'none', borderRadius: '4px' }}
              />
            ) : (
              <img
                src={receiptPreviewUrl!}
                alt="Receipt preview"
                style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain', borderRadius: '4px' }}
              />
            )}
          </div>

          {/* Right: Form Inputs */}
          <div style={{ flex: 1, padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>New Receipt Expense</h3>
            {uploadError && <div style={{ color: '#ef5350', fontSize: '13px' }}>{uploadError}</div>}

            <div>
              <label style={labelStyle}>Name / Description</label>
              <input type="text" value={receiptForm.description} onChange={(e) => setReceiptForm({ ...receiptForm, description: e.target.value })} placeholder="e.g. Hotel, Fuel, Parts..." style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Date</label>
              <input type="date" value={receiptForm.expense_date} onChange={(e) => setReceiptForm({ ...receiptForm, expense_date: e.target.value })} style={inputStyle} />
            </div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Amount ($)</label>
                <input type="number" step="0.01" value={receiptForm.amount} onChange={(e) => setReceiptForm({ ...receiptForm, amount: e.target.value })} placeholder="0.00" style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>GST ($)</label>
                <input type="number" step="0.01" value={receiptForm.gst} onChange={(e) => setReceiptForm({ ...receiptForm, gst: e.target.value })} placeholder="0.00" style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input type="checkbox" id="exp-billable" checked={receiptForm.is_billable} onChange={(e) => setReceiptForm({ ...receiptForm, is_billable: e.target.checked })} />
              <label htmlFor="exp-billable" style={{ fontSize: '14px', color: 'var(--text-primary)', cursor: 'pointer' }}>Billable</label>
            </div>
            <div>
              <label style={labelStyle}>Notes (optional)</label>
              <textarea value={receiptForm.notes} onChange={(e) => setReceiptForm({ ...receiptForm, notes: e.target.value })} rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '12px' }}>
              <button
                onClick={() => { setReceiptFile(null); setReceiptPreviewUrl(null); setReceiptForm(initialReceiptForm); setUploadError(null); }}
                style={{ flex: 1, padding: '10px', backgroundColor: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' }}
              >
                Cancel
              </button>
              <button
                disabled={isUploading}
                onClick={handleSubmitReceipt}
                style={{ flex: 1, padding: '10px', backgroundColor: 'var(--primary-color)', color: 'white', border: 'none', borderRadius: '6px', cursor: isUploading ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: '600', opacity: isUploading ? 0.7 : 1 }}
              >
                {isUploading ? 'Saving...' : 'Save Receipt'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Expenses Table */}
      {isLoading ? (
        <div style={{ color: 'var(--text-tertiary)', padding: '24px', textAlign: 'center' }}>Loading expenses...</div>
      ) : (
        <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Date</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Description</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Amount</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>GST</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Billable</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Status</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Ticket</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((exp: any) => (
                <tr key={exp.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '12px 16px', fontSize: '14px' }}>{new Date(exp.expense_date).toLocaleDateString()}</td>
                  <td style={{ padding: '12px 16px', fontSize: '14px' }}>
                    <div style={{ fontWeight: '500' }}>{exp.description}</div>
                    {exp.receipt_url && (
                      <button
                        onClick={() => handleViewReceipt(exp)}
                        style={{ fontSize: '12px', color: 'var(--primary-color)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: '2px' }}
                      >
                        {loadingReceiptId === exp.id ? 'Loading...' : 'View Receipt'}
                      </button>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '500', fontSize: '14px' }}>${parseFloat(exp.amount).toFixed(2)}</td>
                  <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: '14px', color: 'var(--text-tertiary)' }}>${parseFloat(exp.gst || 0).toFixed(2)}</td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontSize: '13px' }}>
                    {exp.is_billable ? (
                      <span style={{ color: '#2196F3', fontWeight: '600' }}>Yes</span>
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)' }}>No</span>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    <span style={{
                      padding: '4px 8px',
                      borderRadius: '12px',
                      fontSize: '12px',
                      backgroundColor: exp.status === 'approved' ? 'rgba(16, 185, 129, 0.1)' :
                                       exp.status === 'rejected' ? 'rgba(239, 68, 68, 0.1)' :
                                       exp.status === 'paid' ? 'rgba(59, 130, 246, 0.1)' :
                                       'rgba(245, 158, 11, 0.1)',
                      color: exp.status === 'approved' ? '#10b981' :
                             exp.status === 'rejected' ? '#ef4444' :
                             exp.status === 'paid' ? '#3b82f6' :
                             '#f59e0b',
                    }}>
                      {exp.status.charAt(0).toUpperCase() + exp.status.slice(1)}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontSize: '13px' }}>
                    {exp.service_tickets?.ticket_number || (
                      exp.is_billable && !exp.service_ticket_id ? (
                        <button
                          onClick={() => { setApplyExpenseId(exp.id); setShowTicketPickerModal(true); setTicketSearchQuery(''); }}
                          style={{ padding: '3px 8px', backgroundColor: 'rgba(33, 150, 243, 0.1)', color: '#2196F3', border: '1px solid rgba(33, 150, 243, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}
                        >
                          Apply to Ticket
                        </button>
                      ) : '-'
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                    <button
                      onClick={() => { if (confirm('Delete this expense?')) deleteExpenseMutation.mutate(exp.id); }}
                      style={{ color: '#ef5350', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px' }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {expenses.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: '32px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '14px' }}>
                    No expenses found. Drop a receipt above to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Admin: Expense Approval Section */}
      {isAdmin && (
        <div style={{ marginTop: '40px' }}>
          <h2 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '16px' }}>
            Expense Approvals
          </h2>

          {/* Status filter tabs */}
          <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
            {(['pending', 'approved', 'rejected', 'paid', 'all'] as const).map((status) => (
              <button
                key={status}
                onClick={() => setAdminStatusFilter(status)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: adminStatusFilter === status ? '1px solid var(--primary-color)' : '1px solid var(--border-color)',
                  backgroundColor: adminStatusFilter === status ? 'rgba(33, 150, 243, 0.1)' : 'transparent',
                  color: adminStatusFilter === status ? 'var(--primary-color)' : 'var(--text-secondary)',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {status}{status !== 'all' ? ` (${expenses.filter((e: any) => e.status === status).length})` : ` (${expenses.length})`}
              </button>
            ))}
          </div>

          <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Employee</th>
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Date</th>
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Description</th>
                  <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Amount</th>
                  <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>GST</th>
                  <th style={{ padding: '10px 14px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Billable</th>
                  <th style={{ padding: '10px 14px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Status</th>
                  <th style={{ padding: '10px 14px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Ticket</th>
                  <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {adminFilteredExpenses.map((exp: any) => {
                  const employeeName = exp.users
                    ? `${exp.users.first_name || ''} ${exp.users.last_name || ''}`.trim() || exp.users.email
                    : 'Unknown';
                  const isUpdating = updatingExpenseId === exp.id;
                  return (
                    <tr key={exp.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '10px 14px', fontSize: '13px', fontWeight: '500' }}>{employeeName}</td>
                      <td style={{ padding: '10px 14px', fontSize: '13px' }}>{new Date(exp.expense_date).toLocaleDateString()}</td>
                      <td style={{ padding: '10px 14px', fontSize: '13px' }}>
                        <div style={{ fontWeight: '500' }}>{exp.description}</div>
                        {exp.receipt_url && (
                          <button
                            onClick={() => handleViewReceipt(exp)}
                            style={{ fontSize: '11px', color: 'var(--primary-color)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: '2px' }}
                          >
                            {loadingReceiptId === exp.id ? 'Loading...' : 'View Receipt'}
                          </button>
                        )}
                        {exp.notes && <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>Note: {exp.notes}</div>}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '500', fontSize: '13px' }}>${parseFloat(exp.amount).toFixed(2)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: '13px', color: 'var(--text-tertiary)' }}>${parseFloat(exp.gst || 0).toFixed(2)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', fontSize: '12px' }}>
                        {exp.is_billable ? <span style={{ color: '#2196F3', fontWeight: '600' }}>Yes</span> : <span style={{ color: 'var(--text-tertiary)' }}>No</span>}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                        <span style={{
                          padding: '3px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600',
                          backgroundColor: exp.status === 'approved' ? 'rgba(16, 185, 129, 0.1)' : exp.status === 'rejected' ? 'rgba(239, 68, 68, 0.1)' : exp.status === 'paid' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                          color: exp.status === 'approved' ? '#10b981' : exp.status === 'rejected' ? '#ef4444' : exp.status === 'paid' ? '#3b82f6' : '#f59e0b',
                        }}>
                          {exp.status.charAt(0).toUpperCase() + exp.status.slice(1)}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', fontSize: '12px' }}>
                        {exp.service_tickets?.ticket_number || '-'}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {exp.status === 'pending' && (
                          <>
                            <button
                              disabled={isUpdating}
                              onClick={() => handleAdminStatusChange(exp.id, 'approved')}
                              style={{ padding: '3px 8px', marginRight: '4px', backgroundColor: 'rgba(16, 185, 129, 0.1)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                            >
                              Approve
                            </button>
                            <button
                              disabled={isUpdating}
                              onClick={() => handleAdminStatusChange(exp.id, 'rejected')}
                              style={{ padding: '3px 8px', backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {exp.status === 'approved' && (
                          <button
                            disabled={isUpdating}
                            onClick={() => handleAdminStatusChange(exp.id, 'paid')}
                            style={{ padding: '3px 8px', backgroundColor: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                          >
                            Mark Paid
                          </button>
                        )}
                        {exp.status === 'rejected' && (
                          <button
                            disabled={isUpdating}
                            onClick={() => handleAdminStatusChange(exp.id, 'approved')}
                            style={{ padding: '3px 8px', backgroundColor: 'rgba(16, 185, 129, 0.1)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                          >
                            Re-approve
                          </button>
                        )}
                        {exp.status === 'paid' && (
                          <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Done</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {adminFilteredExpenses.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '14px' }}>
                      No {adminStatusFilter === 'all' ? '' : adminStatusFilter} expenses found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Ticket Picker Modal */}
      {showTicketPickerModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10003, backgroundColor: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => { setShowTicketPickerModal(false); setApplyExpenseId(null); }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            backgroundColor: 'var(--bg-primary)', borderRadius: '10px', width: '90%', maxWidth: '600px',
            maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ padding: '20px 24px 12px', borderBottom: '1px solid var(--border-color)' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>Select a Service Ticket</h3>
              <input
                type="text"
                placeholder="Search by ticket # or location..."
                value={ticketSearchQuery}
                onChange={(e) => setTicketSearchQuery(e.target.value)}
                style={{ ...inputStyle, marginBottom: '4px' }}
                autoFocus
              />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 24px 24px' }}>
              {filteredPickerTickets.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '14px' }}>
                  No un-invoiced tickets found.
                </div>
              ) : (
                filteredPickerTickets.map((t: any) => (
                  <div
                    key={t.id}
                    onClick={() => handleApplyToTicket(t.id, t.ticket_number || 'Draft')}
                    style={{
                      padding: '12px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-color)',
                      marginBottom: '8px',
                      cursor: 'pointer',
                      transition: 'background-color 0.15s',
                      backgroundColor: 'var(--bg-secondary)',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--bg-tertiary)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--bg-secondary)'; }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: '600', fontSize: '14px', color: 'var(--text-primary)' }}>
                        {t.ticket_number || <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>Draft</span>}
                      </span>
                      <span style={{ fontSize: '12px', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b' }}>
                        {t.workflow_status || 'draft'}
                      </span>
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      {t.location || 'No location'} &middot; {t.date ? new Date(t.date).toLocaleDateString() : 'No date'}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Receipt Viewer Modal */}
      {viewingReceiptUrl && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10004, backgroundColor: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setViewingReceiptUrl(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', width: viewingReceiptIsPdf ? '80vw' : 'auto', height: viewingReceiptIsPdf ? '90vh' : 'auto', maxWidth: '90vw', maxHeight: '90vh' }}>
            <button
              onClick={() => setViewingReceiptUrl(null)}
              style={{ position: 'absolute', top: -12, right: -12, zIndex: 1, width: '28px', height: '28px', borderRadius: '50%', backgroundColor: '#333', color: 'white', border: 'none', cursor: 'pointer', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              &times;
            </button>
            {viewingReceiptIsPdf ? (
              <iframe src={viewingReceiptUrl} title="Receipt PDF" style={{ width: '100%', height: '100%', border: 'none', borderRadius: '8px', backgroundColor: 'white' }} />
            ) : (
              <img src={viewingReceiptUrl} alt="Receipt" style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
