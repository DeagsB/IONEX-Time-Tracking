/**
 * QuickBooks Online Frontend Service
 * Handles communication with backend QuickBooks API endpoints
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

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
    
    // Get auth token from localStorage or session
    const token = localStorage.getItem('authToken');
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
        // Store state for verification
        sessionStorage.setItem('qbo_state', data.state);
        return data.authUrl;
      }
      return null;
    } catch (error) {
      console.error('Error getting auth URL:', error);
      return null;
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
