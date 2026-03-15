import React, { useState, useRef, useMemo } from 'react';
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
  const { user, isAdmin } = useAuth();
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

  // Markup modal state (step 2 after picking a ticket)
  const [markupModalTicket, setMarkupModalTicket] = useState<{ id: string; ticketNumber: string } | null>(null);
  const [markupValue, setMarkupValue] = useState('0');
  const [markupType, setMarkupType] = useState<'dollar' | 'percent'>('dollar');
  const [isApplyingMarkup, setIsApplyingMarkup] = useState(false);

  // Viewing receipt
  const [viewingReceiptUrl, setViewingReceiptUrl] = useState<string | null>(null);
  const [viewingReceiptIsPdf, setViewingReceiptIsPdf] = useState(false);
  const [loadingReceiptId, setLoadingReceiptId] = useState<string | null>(null);

  // Admin approval
  const [adminStatusFilter, setAdminStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'paid' | 'all'>('pending');
  const [updatingExpenseId, setUpdatingExpenseId] = useState<string | null>(null);

  // Edit receipt
  const [editingExpense, setEditingExpense] = useState<any>(null);
  const [editForm, setEditForm] = useState({ description: '', amount: '', gst: '', is_billable: false, expense_date: '', notes: '' });
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Ticket details popup (inside picker)
  const [detailsTicketId, setDetailsTicketId] = useState<string | null>(null);

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['userExpenses'],
    queryFn: () => userExpensesService.getAll(),
  });

  const { data: allTicketRecords = [] } = useQuery({
    queryKey: ['ticketsForExpensePicker', isDemoMode, isAdmin, user?.id],
    queryFn: async () => {
      const tableName = isDemoMode ? 'service_tickets_demo' : 'service_tickets';
      let query = supabase
        .from(tableName)
        .select('id, ticket_number, date, location, workflow_status, user_id, customers(name), projects(name, project_number)')
        .order('date', { ascending: false })
        .limit(200);

      if (!isAdmin && user?.id) {
        query = query.eq('user_id', user.id);
      }

      const { data, error } = await query;
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

  // Admin: own tickets first, then others. Non-admin: already filtered to own.
  const sortedUninvoiced = isAdmin && user?.id
    ? [...uninvoicedTickets].sort((a: any, b: any) => {
        const aOwn = a.user_id === user.id ? 0 : 1;
        const bOwn = b.user_id === user.id ? 0 : 1;
        if (aOwn !== bOwn) return aOwn - bOwn;
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      })
    : uninvoicedTickets;

  const filteredPickerTickets = sortedUninvoiced.filter((t: any) => {
    if (!ticketSearchQuery.trim()) return true;
    const q = ticketSearchQuery.toLowerCase();
    return (
      (t.ticket_number || '').toLowerCase().includes(q) ||
      (t.location || '').toLowerCase().includes(q) ||
      (t.customers?.name || '').toLowerCase().includes(q) ||
      (t.projects?.name || '').toLowerCase().includes(q) ||
      (t.projects?.project_number || '').toLowerCase().includes(q)
    );
  });

  const detailsTicket = allTicketRecords.find((t: any) => t.id === detailsTicketId) as any;

  const { data: ticketDetails, isLoading: isLoadingDetails } = useQuery({
    queryKey: ['ticketPickerDetails', detailsTicketId],
    queryFn: async () => {
      if (!detailsTicketId || !detailsTicket) return null;
      const [timeRes, expRes] = await Promise.all([
        supabase
          .from('time_entries')
          .select('id, date, hours, rate_type, description, start_time, end_time')
          .eq('user_id', detailsTicket.user_id)
          .eq('date', detailsTicket.date)
          .eq('billable', true)
          .not('project_id', 'is', null)
          .order('start_time', { ascending: true }),
        supabase
          .from('service_ticket_expenses')
          .select('id, expense_type, description, quantity, rate, unit')
          .eq('service_ticket_id', detailsTicketId)
          .order('created_at', { ascending: true }),
      ]);
      if (timeRes.error) throw timeRes.error;
      if (expRes.error) throw expRes.error;
      return { timeEntries: timeRes.data || [], expenses: expRes.data || [] };
    },
    enabled: !!detailsTicketId && !!detailsTicket,
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: (id: string) => userExpensesService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
    },
  });

  const handleStartEdit = (exp: any) => {
    setEditingExpense(exp);
    setEditForm({
      description: exp.description || '',
      amount: String(parseFloat(exp.amount)),
      gst: String(parseFloat(exp.gst || 0)),
      is_billable: exp.is_billable || false,
      expense_date: exp.expense_date || '',
      notes: exp.notes || '',
    });
  };

  const handleSaveEdit = async () => {
    if (!editingExpense) return;
    if (!editForm.description.trim()) { alert('Description is required'); return; }
    if (!editForm.amount || parseFloat(editForm.amount) <= 0) { alert('Amount must be greater than 0'); return; }
    setIsSavingEdit(true);
    try {
      await userExpensesService.updateAndSyncTicket(editingExpense.id, {
        description: editForm.description.trim(),
        amount: parseFloat(editForm.amount),
        gst: parseFloat(editForm.gst) || 0,
        is_billable: editForm.is_billable,
        expense_date: editForm.expense_date,
        notes: editForm.notes.trim(),
      });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      setEditingExpense(null);
    } catch (err: any) {
      alert('Failed to save: ' + (err.message || 'Unknown error'));
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Fetch service ticket expenses that need reimbursement (admin only)
  const { data: ticketReimbExpenses = [] } = useQuery({
    queryKey: ['ticketReimbExpenses'],
    queryFn: () => serviceTicketExpensesService.getNeedsReimbursement(),
    enabled: isAdmin,
  });

  const handleAdminStatusChange = async (itemId: string, newStatus: 'approved' | 'rejected' | 'paid', source: 'receipt' | 'ticket') => {
    setUpdatingExpenseId(itemId);
    try {
      if (source === 'ticket') {
        await serviceTicketExpensesService.updateReimbursementStatus(itemId, newStatus);
        queryClient.invalidateQueries({ queryKey: ['ticketReimbExpenses'] });
      } else {
        await userExpensesService.update(itemId, { status: newStatus });

        if (newStatus === 'rejected') {
          const expense = expenses.find((e: any) => e.id === itemId);
          if (expense?.service_ticket_id) {
            await userExpensesService._removeLinkedTicketExpense(expense.service_ticket_id, expense.description);
            await userExpensesService.update(itemId, { service_ticket_id: null, markup_amount: 0 });
            queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
          }
        }

        queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      }
    } catch (err: any) {
      alert('Failed to update status: ' + (err.message || 'Unknown error'));
    } finally {
      setUpdatingExpenseId(null);
    }
  };

  // Merge receipt expenses + ticket reimbursement expenses into one admin list
  const mergedAdminExpenses = useMemo(() => {
    const receiptItems = expenses.map((exp: any) => ({
      ...exp,
      _source: 'receipt' as const,
      _status: exp.status,
      _employeeName: exp.users ? `${exp.users.first_name || ''} ${exp.users.last_name || ''}`.trim() || exp.users.email : 'Unknown',
      _ticketNumber: exp.service_tickets?.ticket_number || null,
      _amount: parseFloat(exp.amount),
      _date: exp.expense_date,
    }));
    const ticketItems = ticketReimbExpenses.map((exp: any) => ({
      ...exp,
      _source: 'ticket' as const,
      _status: exp.reimbursement_status || 'pending',
      _employeeName: '', // Will be populated from service_tickets.user_id join if available
      _ticketNumber: exp.service_tickets?.ticket_number || null,
      _amount: (Number(exp.quantity) || 0) * (Number(exp.rate) || 0),
      _date: exp.service_tickets?.date || exp.created_at?.split('T')[0],
    }));
    return [...receiptItems, ...ticketItems].sort((a, b) => new Date(b._date).getTime() - new Date(a._date).getTime());
  }, [expenses, ticketReimbExpenses]);

  const adminFilteredExpenses = mergedAdminExpenses.filter((exp: any) => {
    if (adminStatusFilter === 'all') return true;
    return exp._status === adminStatusFilter;
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

  const handlePickTicketForMarkup = (ticketRecordId: string, ticketNumber: string) => {
    setMarkupModalTicket({ id: ticketRecordId, ticketNumber });
    setMarkupValue('0');
    setMarkupType('dollar');
    setShowTicketPickerModal(false);
  };

  const handleConfirmMarkup = async () => {
    if (!applyExpenseId || !markupModalTicket) return;
    const expense = expenses.find((e: any) => e.id === applyExpenseId);
    if (!expense) return;

    const expAmt = parseFloat(expense.amount);
    let markup = 0;
    const val = parseFloat(markupValue) || 0;
    if (markupType === 'percent') {
      markup = (expAmt * val) / 100;
    } else {
      markup = val;
    }
    const totalWithMarkup = expAmt + markup;

    setIsApplyingMarkup(true);
    try {
      await userExpensesService.update(applyExpenseId, {
        service_ticket_id: markupModalTicket.id,
        markup_amount: markup,
      });
      await serviceTicketExpensesService.create({
        service_ticket_id: markupModalTicket.id,
        expense_type: 'Expenses',
        description: expense.description,
        quantity: 1,
        rate: totalWithMarkup,
        unit: '',
      });
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      queryClient.invalidateQueries({ queryKey: ['unappliedBillableReceipts'] });
      queryClient.invalidateQueries({ queryKey: ['serviceTicketExpenseTotals'] });
      setMarkupModalTicket(null);
      setApplyExpenseId(null);
    } catch (err: any) {
      alert('Failed to apply expense to ticket: ' + (err.message || 'Unknown error'));
    } finally {
      setIsApplyingMarkup(false);
    }
  };

  const handleBackToTicketPicker = () => {
    setMarkupModalTicket(null);
    setShowTicketPickerModal(true);
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
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', width: '50px' }}></th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((exp: any) => (
                <tr
                  key={exp.id}
                  onClick={() => handleStartEdit(exp)}
                  style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer', transition: 'background-color 0.15s' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--bg-secondary)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = ''; }}
                >
                  <td style={{ padding: '12px 16px', fontSize: '14px' }}>{new Date(exp.expense_date + 'T12:00:00').toLocaleDateString()}</td>
                  <td style={{ padding: '12px 16px', fontSize: '14px' }}>
                    <div style={{ fontWeight: '500' }}>{exp.description}</div>
                    {exp.receipt_url && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleViewReceipt(exp); }}
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
                          onClick={(e) => { e.stopPropagation(); setApplyExpenseId(exp.id); setShowTicketPickerModal(true); setTicketSearchQuery(''); }}
                          style={{ padding: '3px 8px', backgroundColor: 'rgba(33, 150, 243, 0.1)', color: '#2196F3', border: '1px solid rgba(33, 150, 243, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}
                        >
                          Apply to Ticket
                        </button>
                      ) : '-'
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (confirm('Delete this expense?')) deleteExpenseMutation.mutate(exp.id); }}
                      title="Delete"
                      style={{ color: '#ef5350', background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', padding: '6px', lineHeight: 1, borderRadius: '4px', transition: 'background-color 0.15s' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(239, 83, 80, 0.15)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
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
                {status}{status !== 'all' ? ` (${mergedAdminExpenses.filter((e: any) => e._status === status).length})` : ` (${mergedAdminExpenses.length})`}
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
                  const isUpdating = updatingExpenseId === exp.id;
                  const status = exp._status;
                  const source = exp._source;
                  return (
                    <tr key={`${source}-${exp.id}`} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '10px 14px', fontSize: '13px', fontWeight: '500' }}>
                        {exp._employeeName || '-'}
                        {source === 'ticket' && <div style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>Ticket Expense</div>}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: '13px' }}>{exp._date ? new Date(exp._date + 'T12:00:00').toLocaleDateString() : '-'}</td>
                      <td style={{ padding: '10px 14px', fontSize: '13px' }}>
                        <div style={{ fontWeight: '500' }}>{exp.description}</div>
                        {source === 'receipt' && exp.receipt_url && (
                          <button
                            onClick={() => handleViewReceipt(exp)}
                            style={{ fontSize: '11px', color: 'var(--primary-color)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: '2px' }}
                          >
                            {loadingReceiptId === exp.id ? 'Loading...' : 'View Receipt'}
                          </button>
                        )}
                        {source === 'ticket' && exp.expense_type && (
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{exp.expense_type}{exp.unit ? ` (${exp.quantity} ${exp.unit})` : ''}</div>
                        )}
                        {exp.notes && <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>Note: {exp.notes}</div>}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: '500', fontSize: '13px' }}>${exp._amount.toFixed(2)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: '13px', color: 'var(--text-tertiary)' }}>{source === 'receipt' ? `$${parseFloat(exp.gst || 0).toFixed(2)}` : '-'}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', fontSize: '12px' }}>
                        {source === 'receipt' ? (exp.is_billable ? <span style={{ color: '#2196F3', fontWeight: '600' }}>Yes</span> : <span style={{ color: 'var(--text-tertiary)' }}>No</span>) : <span style={{ color: 'var(--text-tertiary)' }}>-</span>}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                        <span style={{
                          padding: '3px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600',
                          backgroundColor: status === 'approved' ? 'rgba(16, 185, 129, 0.1)' : status === 'rejected' ? 'rgba(239, 68, 68, 0.1)' : status === 'paid' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                          color: status === 'approved' ? '#10b981' : status === 'rejected' ? '#ef4444' : status === 'paid' ? '#3b82f6' : '#f59e0b',
                        }}>
                          {status.charAt(0).toUpperCase() + status.slice(1)}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center', fontSize: '12px' }}>
                        {exp._ticketNumber || '-'}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {status === 'pending' && (
                          <>
                            <button
                              disabled={isUpdating}
                              onClick={() => handleAdminStatusChange(exp.id, 'approved', source)}
                              style={{ padding: '3px 8px', marginRight: '4px', backgroundColor: 'rgba(16, 185, 129, 0.1)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                            >
                              Approve
                            </button>
                            <button
                              disabled={isUpdating}
                              onClick={() => handleAdminStatusChange(exp.id, 'rejected', source)}
                              style={{ padding: '3px 8px', backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {status === 'approved' && (
                          <button
                            disabled={isUpdating}
                            onClick={() => handleAdminStatusChange(exp.id, 'paid', source)}
                            style={{ padding: '3px 8px', backgroundColor: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                          >
                            Mark Paid
                          </button>
                        )}
                        {status === 'rejected' && (
                          <button
                            disabled={isUpdating}
                            onClick={() => handleAdminStatusChange(exp.id, 'approved', source)}
                            style={{ padding: '3px 8px', backgroundColor: 'rgba(16, 185, 129, 0.1)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '4px', fontSize: '11px', fontWeight: '600', cursor: isUpdating ? 'not-allowed' : 'pointer' }}
                          >
                            Re-approve
                          </button>
                        )}
                        {status === 'paid' && (
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
        }} onClick={() => { setShowTicketPickerModal(false); setApplyExpenseId(null); setDetailsTicketId(null); }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            backgroundColor: 'var(--bg-primary)', borderRadius: '10px', width: '90%', maxWidth: '600px',
            maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ padding: '20px 24px 12px', borderBottom: '1px solid var(--border-color)' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)' }}>Select a Service Ticket</h3>
              <input
                type="text"
                placeholder="Search by ticket #, customer, project, or location..."
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
                  <div key={t.id} style={{ marginBottom: '8px' }}>
                    <div
                      onClick={() => handlePickTicketForMarkup(t.id, t.ticket_number || 'Draft')}
                      style={{
                        padding: '12px',
                        borderRadius: detailsTicketId === t.id ? '6px 6px 0 0' : '6px',
                        border: '1px solid var(--border-color)',
                        borderBottom: detailsTicketId === t.id ? 'none' : '1px solid var(--border-color)',
                        cursor: 'pointer',
                        transition: 'background-color 0.15s',
                        backgroundColor: 'var(--bg-secondary)',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--bg-tertiary)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--bg-secondary)'; }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1, textAlign: 'left' }}>
                          <span style={{ fontWeight: '600', fontSize: '14px', color: 'var(--text-primary)', flexShrink: 0 }}>
                            {t.ticket_number || ''}
                          </span>
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.customers?.name || 'No Customer'}{t.projects?.name ? ` — ${t.projects.name}` : ''}{t.projects?.project_number ? ` (${t.projects.project_number})` : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, marginLeft: '8px' }}>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDetailsTicketId(detailsTicketId === t.id ? null : t.id); }}
                            style={{
                              padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border-color)',
                              backgroundColor: detailsTicketId === t.id ? 'var(--primary-color)' : 'transparent',
                              color: detailsTicketId === t.id ? 'white' : 'var(--text-secondary)',
                              fontSize: '11px', cursor: 'pointer', fontWeight: '500', whiteSpace: 'nowrap',
                            }}
                          >
                            {detailsTicketId === t.id ? 'Hide' : 'Details'}
                          </button>
                          <span style={{ fontSize: '12px', padding: '2px 8px', borderRadius: '10px', backgroundColor: t.workflow_status === 'approved' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)', color: t.workflow_status === 'approved' ? '#10b981' : '#f59e0b' }}>
                            {t.workflow_status || 'draft'}
                          </span>
                        </div>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '4px', textAlign: 'left' }}>
                        {t.location ? t.location : 'No location'} &middot; {t.date ? new Date(t.date + 'T12:00:00').toLocaleDateString() : 'No date'}
                      </div>
                    </div>

                    {detailsTicketId === t.id && (
                      <div style={{
                        border: '1px solid var(--border-color)', borderTop: '1px dashed var(--border-color)',
                        borderRadius: '0 0 6px 6px', padding: '12px 14px',
                        backgroundColor: 'var(--bg-primary)', fontSize: '13px', textAlign: 'left',
                      }}>
                        {isLoadingDetails ? (
                          <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', padding: '12px 0' }}>Loading...</div>
                        ) : !ticketDetails ? (
                          <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', padding: '12px 0' }}>No data.</div>
                        ) : (
                          <>
                            {/* Time Entries */}
                            <div style={{ marginBottom: ticketDetails.expenses.length > 0 ? '12px' : 0, textAlign: 'left' }}>
                              <div style={{ fontWeight: '700', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px', textAlign: 'left' }}>
                                Time Entries ({ticketDetails.timeEntries.length})
                              </div>
                              {ticketDetails.timeEntries.length === 0 ? (
                                <div style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>No time entries.</div>
                              ) : (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                                  <thead>
                                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                      <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Type</th>
                                      <th style={{ textAlign: 'right', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Hours</th>
                                      <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Description</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ticketDetails.timeEntries.map((te: any) => (
                                      <tr key={te.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                        <td style={{ padding: '4px 6px', color: 'var(--text-primary)' }}>{te.rate_type || 'Shop Time'}</td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: '600', color: 'var(--text-primary)' }}>{Number(te.hours).toFixed(1)}</td>
                                        <td style={{ padding: '4px 6px', color: 'var(--text-tertiary)', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{te.description || '—'}</td>
                                      </tr>
                                    ))}
                                    <tr>
                                      <td style={{ padding: '4px 6px', fontWeight: '700', color: 'var(--text-primary)' }}>Total</td>
                                      <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: '700', color: 'var(--text-primary)' }}>
                                        {ticketDetails.timeEntries.reduce((s: number, te: any) => s + Number(te.hours), 0).toFixed(1)}
                                      </td>
                                      <td />
                                    </tr>
                                  </tbody>
                                </table>
                              )}
                            </div>

                            {/* Expenses */}
                            {ticketDetails.expenses.length > 0 && (
                              <div style={{ textAlign: 'left' }}>
                                <div style={{ fontWeight: '700', fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px', textAlign: 'left' }}>
                                  Expenses ({ticketDetails.expenses.length})
                                </div>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                                  <thead>
                                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                      <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Type</th>
                                      <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Description</th>
                                      <th style={{ textAlign: 'right', padding: '4px 6px', color: 'var(--text-secondary)', fontWeight: '600' }}>Amount</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ticketDetails.expenses.map((ex: any) => (
                                      <tr key={ex.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                        <td style={{ padding: '4px 6px', color: 'var(--text-primary)' }}>{ex.expense_type || '—'}</td>
                                        <td style={{ padding: '4px 6px', color: 'var(--text-primary)' }}>{ex.description || '—'}</td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: '600', color: 'var(--text-primary)' }}>
                                          ${(Number(ex.quantity || 0) * Number(ex.rate || 0)).toFixed(2)}
                                        </td>
                                      </tr>
                                    ))}
                                    <tr>
                                      <td colSpan={2} style={{ padding: '4px 6px', fontWeight: '700', color: 'var(--text-primary)' }}>Total</td>
                                      <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: '700', color: 'var(--text-primary)' }}>
                                        ${ticketDetails.expenses.reduce((s: number, ex: any) => s + Number(ex.quantity || 0) * Number(ex.rate || 0), 0).toFixed(2)}
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )))
              }
            </div>
          </div>
        </div>
      )}

      {/* Markup Modal (step 2 after picking a ticket) */}
      {markupModalTicket && applyExpenseId && (() => {
        const expense = expenses.find((e: any) => e.id === applyExpenseId);
        if (!expense) return null;
        const expAmt = parseFloat(expense.amount);
        const val = parseFloat(markupValue) || 0;
        const markup = markupType === 'percent' ? (expAmt * val) / 100 : val;
        const total = expAmt + markup;

        return (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 10003, backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onClick={() => { setMarkupModalTicket(null); setApplyExpenseId(null); }}>
            <div onClick={(e) => e.stopPropagation()} style={{
              backgroundColor: 'var(--bg-primary)', borderRadius: '12px', padding: '24px',
              maxWidth: '420px', width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)' }}>Apply Markup</h3>
                <button onClick={() => { setMarkupModalTicket(null); setApplyExpenseId(null); }} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)' }}>&times;</button>
              </div>

              <div style={{ marginBottom: '16px', padding: '10px 12px', backgroundColor: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '13px' }}>
                <div><span style={{ color: 'var(--text-secondary)' }}>Expense:</span> <span style={{ fontWeight: '600' }}>{expense.description}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Amount:</span> <span style={{ fontWeight: '600' }}>${expAmt.toFixed(2)}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Ticket:</span> <span style={{ fontWeight: '600' }}>{markupModalTicket.ticketNumber}</span></div>
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>Markup</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={markupValue}
                    onChange={(e) => setMarkupValue(e.target.value)}
                    style={{ ...inputStyle, flex: 1 }}
                    autoFocus
                  />
                  <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                    <button
                      onClick={() => setMarkupType('dollar')}
                      style={{
                        padding: '8px 12px', border: 'none', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
                        backgroundColor: markupType === 'dollar' ? 'var(--primary-color)' : 'var(--bg-secondary)',
                        color: markupType === 'dollar' ? 'white' : 'var(--text-secondary)',
                      }}
                    >$</button>
                    <button
                      onClick={() => setMarkupType('percent')}
                      style={{
                        padding: '8px 12px', border: 'none', borderLeft: '1px solid var(--border-color)', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
                        backgroundColor: markupType === 'percent' ? 'var(--primary-color)' : 'var(--bg-secondary)',
                        color: markupType === 'percent' ? 'white' : 'var(--text-secondary)',
                      }}
                    >%</button>
                  </div>
                </div>
              </div>

              <div style={{ padding: '10px 12px', backgroundColor: 'rgba(33, 150, 243, 0.08)', borderRadius: '6px', marginBottom: '20px', fontSize: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Markup:</span>
                  <span style={{ fontWeight: '600', color: markup > 0 ? '#2196F3' : 'var(--text-tertiary)' }}>${markup.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', paddingTop: '4px', borderTop: '1px solid var(--border-color)' }}>
                  <span style={{ fontWeight: '700', color: 'var(--text-primary)' }}>Total on Ticket:</span>
                  <span style={{ fontWeight: '700', color: 'var(--text-primary)', fontSize: '16px' }}>${total.toFixed(2)}</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={handleBackToTicketPicker}
                  style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}
                >
                  Back
                </button>
                <button
                  onClick={handleConfirmMarkup}
                  disabled={isApplyingMarkup}
                  style={{ flex: 1, padding: '10px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--primary-color)', color: 'white', fontSize: '13px', fontWeight: '600', cursor: isApplyingMarkup ? 'not-allowed' : 'pointer', opacity: isApplyingMarkup ? 0.7 : 1 }}
                >
                  {isApplyingMarkup ? 'Applying...' : 'Apply to Ticket'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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

      {/* Edit Expense Modal */}
      {editingExpense && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10003, backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setEditingExpense(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            backgroundColor: 'var(--bg-primary)', borderRadius: '12px', padding: '24px',
            maxWidth: '480px', width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)' }}>Edit Expense</h3>
              <button onClick={() => setEditingExpense(null)} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)' }}>&times;</button>
            </div>
            {editingExpense.service_ticket_id && (
              <div style={{ marginBottom: '16px', padding: '8px 12px', backgroundColor: 'rgba(33, 150, 243, 0.1)', borderRadius: '6px', fontSize: '12px', color: '#2196F3' }}>
                Applied to ticket {editingExpense.service_tickets?.ticket_number || editingExpense.service_ticket_id}. Changes will sync to the service ticket.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Description</label>
                <input type="text" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} style={inputStyle} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Amount ($)</label>
                  <input type="number" step="0.01" min="0" value={editForm.amount} onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })} style={inputStyle} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>GST ($)</label>
                  <input type="number" step="0.01" min="0" value={editForm.gst} onChange={(e) => setEditForm({ ...editForm, gst: e.target.value })} style={inputStyle} />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Date</label>
                <input type="date" value={editForm.expense_date} onChange={(e) => setEditForm({ ...editForm, expense_date: e.target.value })} style={inputStyle} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="checkbox" id="edit-billable" checked={editForm.is_billable} onChange={(e) => setEditForm({ ...editForm, is_billable: e.target.checked })} />
                <label htmlFor="edit-billable" style={{ fontSize: '13px', cursor: 'pointer' }}>Billable</label>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>Notes</label>
                <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' }}>
              <button onClick={() => setEditingExpense(null)} style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSaveEdit} disabled={isSavingEdit} style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--primary-color)', color: 'white', fontSize: '13px', fontWeight: '600', cursor: isSavingEdit ? 'not-allowed' : 'pointer', opacity: isSavingEdit ? 0.7 : 1 }}>
                {isSavingEdit ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
