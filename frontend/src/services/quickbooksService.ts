/**
 * QuickBooks Online Frontend Service
 * Handles communication with backend QuickBooks API endpoints
 */

import { supabase } from '../lib/supabaseClient';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/** True when the QuickBooks API base is localhost or local network. Invoicing page skips status checks and QBO calls in that case. */
export function isQuickBooksApiLocal(): boolean {
  try {
    const u = new URL(API_BASE);
    const host = (u.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.startsWith('192.168.') || host.startsWith('10.') || host === '::1') return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

interface InvoiceLineItem {
  description: string;
  amount: number;
  quantity?: number;
  rate?: number;
}

interface CreateInvoiceParams {
  customerName: string;
  customerEmail?: string;
  lineItems: InvoiceLineItem[];
  ticketNumber: string;
  date: string;
  dueDate?: string;
  memo?: string;
}

export interface PoAfeLineItem {
  poAfe: string;
  tickets: string[];
  totalAmount: number;
}

export interface CreateInvoiceFromGroupParams {
  customerName: string;
  customerEmail?: string;
  customerPo?: string;
  reference?: string;
  poAfeLineItems: PoAfeLineItem[];
  date: string;
  docNumber?: string;
}

interface QBOStatusResponse {
  success: boolean;
  connected: boolean;
}

interface QBOAuthUrlResponse {
  success: boolean;
  authUrl: string;
  state: string;
}

interface QBOInvoiceResponse {
  success: boolean;
  invoiceId: string;
  invoiceNumber: string;
}

class QuickBooksClientService {
  private async getAuthHeaders(): Promise<Headers> {
    const headers = new Headers({
      'Content-Type': 'application/json',
    });

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? localStorage.getItem('authToken');
    if (token) {
      headers.append('Authorization', `Bearer ${token}`);
    }

    return headers;
  }

  /**
   * Check if QuickBooks is connected
   */
  async checkStatus(): Promise<boolean> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await fetch(`${API_BASE}/api/quickbooks/status`, { headers });
      const data: QBOStatusResponse = await response.json();
      return data.connected;
    } catch (error) {
      console.error('Error checking QBO status:', error);
      return false;
    }
  }

  /**
   * Get authorization URL to connect QuickBooks
   */
  async getAuthUrl(): Promise<string | null> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await fetch(`${API_BASE}/api/quickbooks/auth-url`, { headers });
      const data: QBOAuthUrlResponse = await response.json();

      if (data.success) {
        sessionStorage.setItem('qbo_state', data.state);
        return data.authUrl;
      }

      if (response.status === 401) {
        throw new Error('Please sign in again to connect QuickBooks.');
      }
      if (response.status === 403) {
        throw new Error('Only admins can connect QuickBooks.');
      }
      if (response.status >= 400) {
        throw new Error((data as { error?: string }).error || 'Could not get QuickBooks authorization URL.');
      }
      return null;
    } catch (err) {
      if (err instanceof Error && (err.message.includes('sign in') || err.message.includes('admins') || err.message.includes('Could not') || err.message.includes('authorization'))) {
        throw err;
      }
      console.error('Error getting auth URL:', err);
      throw new Error('Cannot reach the backend. Ensure it is running and VITE_API_URL is correct.');
    }
  }

  /**
   * Disconnect QuickBooks
   */
  async disconnect(): Promise<boolean> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await fetch(`${API_BASE}/api/quickbooks/disconnect`, {
        method: 'POST',
        headers,
      });
      const data = await response.json();
      return data.success;
    } catch (error) {
      console.error('Error disconnecting QBO:', error);
      return false;
    }
  }

  /**
   * Create an invoice in QuickBooks
   */
  async createInvoice(params: CreateInvoiceParams): Promise<QBOInvoiceResponse | null> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await fetch(`${API_BASE}/api/quickbooks/invoice`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });
      const data = await response.json();
      
      if (data.success) {
        return {
          success: true,
          invoiceId: data.invoiceId,
          invoiceNumber: data.invoiceNumber,
        };
      }
      throw new Error(data.error);
    } catch (error) {
      console.error('Error creating invoice:', error);
      return null;
    }
  }

  /**
   * Create an invoice from grouped service tickets (CNRL format)
   */
  async createInvoiceFromGroup(params: CreateInvoiceFromGroupParams): Promise<QBOInvoiceResponse | null> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await fetch(`${API_BASE}/api/quickbooks/invoice/from-group`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });
      const data = await response.json();

      if (data.success) {
        return {
          success: true,
          invoiceId: data.invoiceId,
          invoiceNumber: data.invoiceNumber,
        };
      }
      throw new Error(data.error || 'Failed to create invoice');
    } catch (error) {
      console.error('Error creating invoice from group:', error);
      throw error;
    }
  }

  /**
   * Attach a PDF to an invoice
   */
  async attachPdfToInvoice(invoiceId: string, pdfBase64: string, fileName: string): Promise<boolean> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await fetch(`${API_BASE}/api/quickbooks/invoice/${invoiceId}/attach`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pdfBase64, fileName }),
      });
      const data = await response.json();
      return data.success;
    } catch (error) {
      console.error('Error attaching PDF:', error);
      return false;
    }
  }
}

export const quickbooksClientService = new QuickBooksClientService();
export default quickbooksClientService;
