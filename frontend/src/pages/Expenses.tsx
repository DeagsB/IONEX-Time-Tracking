import React, { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { userExpensesService } from '../services/supabaseServices';
import { optimizeImage } from '../utils/imageOptimizer';
import { useAuth } from '../context/AuthContext';

export default function Expenses() {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [showAddModal, setShowAddModal] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  
  const [expenseForm, setExpenseForm] = useState({
    amount: '',
    description: '',
    expense_date: new Date().toISOString().split('T')[0],
    notes: '',
  });

  const { data: expenses, isLoading } = useQuery({
    queryKey: ['userExpenses'],
    queryFn: () => userExpensesService.getAll()
  });

  const createExpenseMutation = useMutation({
    mutationFn: (newExpense: Parameters<typeof userExpensesService.create>[0]) => 
      userExpensesService.create(newExpense),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
      setShowAddModal(false);
      setExpenseForm({ amount: '', description: '', expense_date: new Date().toISOString().split('T')[0], notes: '' });
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    onError: (error: any) => {
      setUploadError(error.message);
      setIsUploading(false);
    }
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: (id: string) => userExpensesService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userExpenses'] });
    }
  });

  const handleUploadClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadError(null);
    setShowAddModal(true);
    
    try {
      // 1. Optimize the image (if it is an image)
      const optimizedFile = await optimizeImage(file, { maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
      
      // 2. Upload the optimized file to Supabase storage
      const receipt_url = await userExpensesService.uploadReceipt(optimizedFile);
      
      // 3. We now have a receipt URL. We wait for the user to fill out the form
      // before actually calling `create`.
      // For simplicity in this demo, we'll store the URL in state or just create it immediately
      // with dummy data and let them edit it.
      // Better: we keep the file in a ref, and upload it when they submit the form.
    } catch (err: any) {
      setUploadError(err.message || 'Error processing image');
      setIsUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUploading(true);
    setUploadError(null);

    let receiptUrl = undefined;

    try {
      if (fileInputRef.current?.files?.[0]) {
        const file = fileInputRef.current.files[0];
        const optimizedFile = await optimizeImage(file, { maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
        receiptUrl = await userExpensesService.uploadReceipt(optimizedFile);
      }

      await createExpenseMutation.mutateAsync({
        amount: parseFloat(expenseForm.amount),
        description: expenseForm.description,
        expense_date: expenseForm.expense_date,
        notes: expenseForm.notes,
        receipt_url: receiptUrl,
        status: 'pending'
      });
    } catch (err: any) {
      setUploadError(err.message || 'Failed to save expense');
      setIsUploading(false);
    }
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0, color: 'var(--text-primary)' }}>Internal Expenses & Receipts</h1>
        <button 
          onClick={() => setShowAddModal(true)}
          style={{
            backgroundColor: 'var(--primary-color)',
            color: 'white',
            border: 'none',
            padding: '8px 16px',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: '600'
          }}
        >
          + Add Expense
        </button>
      </div>

      {isLoading ? (
        <div>Loading expenses...</div>
      ) : (
        <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: 'var(--text-secondary)' }}>Date</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: '600', color: 'var(--text-secondary)' }}>Description</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '600', color: 'var(--text-secondary)' }}>Amount</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', color: 'var(--text-secondary)' }}>Status</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: '600', color: 'var(--text-secondary)' }}>Ticket</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '600', color: 'var(--text-secondary)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {expenses?.map((exp) => (
                <tr key={exp.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '12px 16px' }}>{new Date(exp.expense_date).toLocaleDateString()}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <div>{exp.description}</div>
                    {exp.receipt_url && (
                      <a href={exp.receipt_url} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: 'var(--primary-color)' }}>
                        View Receipt
                      </a>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: '500' }}>
                    ${parseFloat(exp.amount).toFixed(2)}
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
                             '#f59e0b'
                    }}>
                      {exp.status.charAt(0).toUpperCase() + exp.status.slice(1)}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    {exp.service_tickets?.ticket_number || '-'}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                    <button
                      onClick={() => {
                        if (confirm('Delete this expense?')) {
                          deleteExpenseMutation.mutate(exp.id);
                        }
                      }}
                      style={{ color: 'var(--logo-red)', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {(!expenses || expenses.length === 0) && (
                <tr>
                  <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                    No expenses found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showAddModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{
            backgroundColor: 'var(--bg-primary)', padding: '24px', borderRadius: '8px', width: '100%', maxWidth: '500px'
          }}>
            <h2 style={{ margin: '0 0 16px 0', fontSize: '18px' }}>Add Internal Expense</h2>
            
            {uploadError && <div style={{ color: 'var(--logo-red)', marginBottom: '16px' }}>{uploadError}</div>}
            
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>Receipt Image</label>
                <input 
                  type="file" 
                  accept="image/*,.pdf" 
                  ref={fileInputRef}
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>Date</label>
                <input 
                  type="date" 
                  required
                  value={expenseForm.expense_date}
                  onChange={e => setExpenseForm({...expenseForm, expense_date: e.target.value})}
                  style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                />
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>Amount ($)</label>
                <input 
                  type="number" 
                  step="0.01"
                  required
                  value={expenseForm.amount}
                  onChange={e => setExpenseForm({...expenseForm, amount: e.target.value})}
                  style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                />
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>Description</label>
                <input 
                  type="text" 
                  required
                  value={expenseForm.description}
                  onChange={e => setExpenseForm({...expenseForm, description: e.target.value})}
                  style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                />
              </div>

              <div style={{ marginBottom: '24px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>Internal Notes (Optional)</label>
                <textarea 
                  value={expenseForm.notes}
                  onChange={e => setExpenseForm({...expenseForm, notes: e.target.value})}
                  style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', minHeight: '60px' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button 
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  style={{ padding: '8px 16px', background: 'none', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  disabled={isUploading}
                  style={{ padding: '8px 16px', backgroundColor: 'var(--primary-color)', color: 'white', border: 'none', borderRadius: '4px', cursor: isUploading ? 'not-allowed' : 'pointer', opacity: isUploading ? 0.7 : 1 }}
                >
                  {isUploading ? 'Saving...' : 'Save Expense'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
