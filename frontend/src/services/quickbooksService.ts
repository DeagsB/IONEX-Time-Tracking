/**
 * QuickBooks Online Frontend Service
 * Handles communication with backend QuickBooks API endpoints
 */

import { supabase } from '../lib/supabaseClient';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/** True when the QuickBooks API base is localhost or local network. Invoicing page skips status
 *  checks and QBO calls in that case — set VITE_QBO_ALLOW_LOCAL=true in .env to bypass this
 *  guard during development (you still need a real OAuth callback wired in the backend). */
export function isQuickBooksApiLocal(): boolean {
  if (String(import.meta.env.VITE_QBO_ALLOW_LOCAL ?? '').toLowerCase() === 'true') return false;
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
   * Create an invoice from grouped service tickets (CNRL format). Throws a labelled error with
   * the backend HTTP status + response body so the caller can map failures to the right backend
   * fix (e.g. unknown customer, missing item ref, expired token).
   */
  async createInvoiceFromGroup(params: CreateInvoiceFromGroupParams): Promise<QBOInvoiceResponse | null> {
    let response: Response;
    try {
      const headers = await this.getAuthHeaders();
      response = await fetch(`${API_BASE}/api/quickbooks/invoice/from-group`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });
    } catch (networkErr) {
      console.error('[QBO-NET] createInvoiceFromGroup network failure:', networkErr);
      throw new Error(`[QBO-NET] Cannot reach backend at ${API_BASE}/api/quickbooks/invoice/from-group. Is the API running and VITE_API_URL pointing at it?`);
    }
    const bodyText = await response.text().catch(() => '');
    let data: { success?: boolean; invoiceId?: string; invoiceNumber?: string; error?: string; code?: string } = {};
    try { data = bodyText ? JSON.parse(bodyText) : {}; } catch { /* non-JSON */ }

    if (response.status === 401) {
      throw new Error(`[QBO-AUTH-401] Backend session is unauthorized — sign in again. (${data.error || bodyText || 'no body'})`);
    }
    if (response.status === 403) {
      throw new Error(`[QBO-AUTH-403] Not allowed to create QuickBooks invoices — only admins can. (${data.error || bodyText || 'no body'})`);
    }
    if (response.status === 400) {
      throw new Error(`[QBO-VALIDATION-400] QuickBooks rejected the invoice payload — likely an unknown customer, missing item, or bad date. Server says: ${data.error || bodyText || 'no body'}`);
    }
    if (response.status === 404) {
      throw new Error(`[QBO-MAP-404] Backend could not find a QBO record (customer/item/realm) for this batch. Server says: ${data.error || bodyText || 'no body'}`);
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new Error(`[QBO-UPSTREAM-${response.status}] QuickBooks Online itself returned an error to the backend. Try again shortly. Server says: ${data.error || bodyText || 'no body'}`);
    }
    if (!response.ok) {
      throw new Error(`[QBO-HTTP-${response.status}] createInvoiceFromGroup failed. Server says: ${data.error || bodyText || 'no body'}`);
    }
    if (!data.success || !data.invoiceId) {
      throw new Error(`[QBO-EMPTY-200] Backend returned 200 but no invoiceId. Server says: ${data.error || bodyText || 'no body'}`);
    }
    return {
      success: true,
      invoiceId: data.invoiceId,
      invoiceNumber: data.invoiceNumber || '',
    };
  }

  /**
   * Download the QBO-generated PDF of an invoice (the version QuickBooks renders, ready to send
   * to the customer). Backend should proxy GET /v3/company/{realmId}/invoice/{id}/pdf with
   * Accept: application/pdf and return the binary blob.
   */
  async downloadInvoicePdf(invoiceId: string): Promise<Blob> {
    let response: Response;
    try {
      const headers = await this.getAuthHeaders();
      headers.set('Accept', 'application/pdf');
      response = await fetch(`${API_BASE}/api/quickbooks/invoice/${invoiceId}/pdf`, { headers });
    } catch (networkErr) {
      console.error('[QBO-NET] downloadInvoicePdf network failure:', networkErr);
      throw new Error(`[QBO-NET] Cannot reach backend at ${API_BASE}/api/quickbooks/invoice/${invoiceId}/pdf.`);
    }
    if (response.status === 404) {
      const errText = await response.text().catch(() => '');
      throw new Error(`[QBO-PDF-404] Backend has no GET /api/quickbooks/invoice/:id/pdf route (or the QBO invoice id ${invoiceId} does not exist). Server says: ${errText || 'no body'}`);
    }
    if (response.status === 401) {
      throw new Error(`[QBO-PDF-401] Backend session is unauthorized — sign in again.`);
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`[QBO-PDF-HTTP-${response.status}] Could not download QuickBooks invoice PDF for ${invoiceId}. Server says: ${errText || 'no body'}`);
    }
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error(`[QBO-PDF-EMPTY] Backend returned a 0-byte PDF for invoice ${invoiceId}.`);
    }
    if (blob.type && !blob.type.includes('pdf') && !blob.type.includes('octet-stream')) {
      console.warn(`[QBO-PDF-MIME] Unexpected content-type: ${blob.type}`);
    }
    return blob;
  }

  /**
   * Attach a PDF to an invoice. Throws with [QBO-ATTACH-…] error codes so the caller can
   * distinguish "QBO invoice was created but PDF attach failed" from a full create failure.
   */
  async attachPdfToInvoice(invoiceId: string, pdfBase64: string, fileName: string): Promise<boolean> {
    let response: Response;
    try {
      const headers = await this.getAuthHeaders();
      response = await fetch(`${API_BASE}/api/quickbooks/invoice/${invoiceId}/attach`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pdfBase64, fileName }),
      });
    } catch (networkErr) {
      console.error('[QBO-NET] attachPdfToInvoice network failure:', networkErr);
      throw new Error(`[QBO-NET] Cannot reach backend at ${API_BASE}/api/quickbooks/invoice/${invoiceId}/attach.`);
    }
    const bodyText = await response.text().catch(() => '');
    let data: { success?: boolean; error?: string } = {};
    try { data = bodyText ? JSON.parse(bodyText) : {}; } catch { /* non-JSON */ }
    if (response.status === 404) {
      throw new Error(`[QBO-ATTACH-404] Backend has no POST /api/quickbooks/invoice/:id/attach route (or invoice ${invoiceId} does not exist). Server says: ${data.error || bodyText || 'no body'}`);
    }
    if (response.status === 401) {
      throw new Error(`[QBO-ATTACH-401] Backend session is unauthorized — sign in again.`);
    }
    if (response.status === 413) {
      throw new Error(`[QBO-ATTACH-413] Supporting PDF is too large for the backend or QuickBooks. Server says: ${data.error || bodyText || 'no body'}`);
    }
    if (!response.ok) {
      throw new Error(`[QBO-ATTACH-HTTP-${response.status}] attachPdfToInvoice failed for ${invoiceId}. Server says: ${data.error || bodyText || 'no body'}`);
    }
    if (!data.success) {
      throw new Error(`[QBO-ATTACH-EMPTY-200] Backend returned 200 but success=false. Server says: ${data.error || bodyText || 'no body'}`);
    }
    return true;
  }
}

export const quickbooksClientService = new QuickBooksClientService();
export default quickbooksClientService;
