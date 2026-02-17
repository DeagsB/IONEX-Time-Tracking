/**
 * QuickBooks Online Frontend Service
 * Handles communication with backend QuickBooks API endpoints
 */

import { supabase } from '../lib/supabaseClient';

// In production (Vercel), use same origin if VITE_API_URL not set so /api/* is used
const API_BASE_RAW =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? '' : 'http://localhost:3001');
// Strip trailing slash so we never get double slashes in URLs (e.g. ...railway.app//api/...)
const API_BASE = typeof API_BASE_RAW === 'string' ? API_BASE_RAW.replace(/\/+$/, '') : '';

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
   * Check if the backend is reachable (for clearer errors before auth flow).
   */
  async checkBackendReachable(): Promise<{ ok: boolean; message?: string }> {
    const url = `${API_BASE}/api/health`;
    try {
      const res = await fetch(url, { method: 'GET', credentials: 'include' });
      if (res.ok) return { ok: true };
      const text = await res.text();
      return { ok: false, message: `Backend returned ${res.status}: ${text.slice(0, 100)}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: msg };
    }
  }

  /**
   * Get authorization URL to connect QuickBooks
   */
  async getAuthUrl(): Promise<string | null> {
    const attemptedUrl = API_BASE ? `${API_BASE}/api/quickbooks/auth-url` : `${typeof window !== 'undefined' ? window.location.origin : ''}/api/quickbooks/auth-url`;
    try {
      const headers = await this.getAuthHeaders();
      const response = await fetch(attemptedUrl, {
        headers,
        credentials: 'include',
      });
      let data: QBOAuthUrlResponse | { error?: string };
      try {
        data = await response.json();
      } catch {
        const text = await response.text().catch(() => '');
        throw new Error(
          response.ok
            ? 'Invalid response from backend.'
            : `Backend returned ${response.status} (not JSON). ${text.slice(0, 80)}`
        );
      }

      if ((data as QBOAuthUrlResponse).success) {
        sessionStorage.setItem('qbo_state', (data as QBOAuthUrlResponse).state);
        return (data as QBOAuthUrlResponse).authUrl;
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
      const isNetwork = err instanceof TypeError && (err.message === 'Failed to fetch' || err.message.includes('NetworkError'));
      const hint = isNetwork
        ? ' Check that the backend is running, CORS allows this origin (FRONTEND_URL or CORS_ORIGINS), and VITE_API_URL is correct.'
        : ` ${err instanceof Error ? err.message : ''}`;
      console.error('Error getting auth URL:', err);
      throw new Error(`Cannot reach the backend at ${attemptedUrl}.${hint}`);
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
