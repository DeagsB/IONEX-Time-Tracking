/**
 * QuickBooks Online Integration Service
 * Handles OAuth2 authentication and invoice creation/management
 */

import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client for token storage
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// QuickBooks OAuth2 configuration
// Optional: QBO_CUSTOM_FIELD_CUSTOMER_PO and QBO_CUSTOM_FIELD_REFERENCE = DefinitionId for invoice custom fields (Customer PO#, Reference)
const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || '';
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || '';
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI || '';
const QBO_ENVIRONMENT = process.env.QBO_ENVIRONMENT || 'sandbox'; // 'sandbox' or 'production'

// QuickBooks API base URLs
const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_API_BASE = QBO_ENVIRONMENT === 'production' 
  ? 'https://quickbooks.api.intuit.com' 
  : 'https://sandbox-quickbooks.api.intuit.com';

interface QBOTokens {
  access_token: string;
  refresh_token: string;
  realm_id: string;
  expires_at: Date;
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

/** Line item for PO/AFE-based invoice (one per PO/AFE) */
interface PoAfeLineItem {
  poAfe: string;
  tickets: string[];
  totalAmount: number;
}

interface CreateInvoiceFromGroupParams {
  customerName: string;
  customerEmail?: string;
  customerPo?: string;
  reference?: string;
  poAfeLineItems: PoAfeLineItem[];
  date: string;
  docNumber?: string;
}

class QuickBooksService {
  /**
   * Generate the OAuth2 authorization URL
   */
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: QBO_CLIENT_ID,
      redirect_uri: QBO_REDIRECT_URI,
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      state: state,
    });
    
    return `${QBO_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access tokens
   */
  async exchangeCodeForTokens(code: string, realmId: string): Promise<QBOTokens> {
    const authHeader = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: QBO_REDIRECT_URI,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code for tokens: ${error}`);
    }

    const data = await response.json();
    
    const tokens: QBOTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      realm_id: realmId,
      expires_at: new Date(Date.now() + data.expires_in * 1000),
    };

    // Store tokens in Supabase
    await this.storeTokens(tokens);
    
    return tokens;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(): Promise<QBOTokens> {
    const storedTokens = await this.getStoredTokens();
    if (!storedTokens) {
      throw new Error('No stored tokens found. Please re-authorize.');
    }

    const authHeader = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: storedTokens.refresh_token,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh token: ${error}`);
    }

    const data = await response.json();
    
    const tokens: QBOTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      realm_id: storedTokens.realm_id,
      expires_at: new Date(Date.now() + data.expires_in * 1000),
    };

    await this.storeTokens(tokens);
    
    return tokens;
  }

  /**
   * Store tokens in Supabase
   */
  private async storeTokens(tokens: QBOTokens): Promise<void> {
    const { error } = await supabase
      .from('qbo_tokens')
      .upsert({
        id: 'primary',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        realm_id: tokens.realm_id,
        expires_at: tokens.expires_at.toISOString(),
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error('Error storing QBO tokens:', error);
      throw error;
    }
  }

  /**
   * Get stored tokens from Supabase
   */
  private async getStoredTokens(): Promise<QBOTokens | null> {
    const { data, error } = await supabase
      .from('qbo_tokens')
      .select('*')
      .eq('id', 'primary')
      .single();

    if (error || !data) {
      return null;
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      realm_id: data.realm_id,
      expires_at: new Date(data.expires_at),
    };
  }

  /**
   * Get valid access token, refreshing if necessary
   */
  async getValidAccessToken(): Promise<{ accessToken: string; realmId: string }> {
    let tokens = await this.getStoredTokens();
    
    if (!tokens) {
      throw new Error('QuickBooks not connected. Please authorize first.');
    }

    // Refresh if token expires within 5 minutes
    if (tokens.expires_at <= new Date(Date.now() + 5 * 60 * 1000)) {
      tokens = await this.refreshAccessToken();
    }

    return {
      accessToken: tokens.access_token,
      realmId: tokens.realm_id,
    };
  }

  /**
   * Check if QuickBooks is connected
   */
  async isConnected(): Promise<boolean> {
    const tokens = await this.getStoredTokens();
    return tokens !== null;
  }

  /**
   * Make an authenticated API request to QuickBooks
   */
  private async makeApiRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    body?: any
  ): Promise<any> {
    const { accessToken, realmId } = await this.getValidAccessToken();
    
    const url = `${QBO_API_BASE}/v3/company/${realmId}${endpoint}`;
    
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`QuickBooks API error: ${error}`);
    }

    return response.json();
  }

  /**
   * Find or create a customer in QuickBooks
   */
  async findOrCreateCustomer(name: string, email?: string): Promise<string> {
    // First, try to find existing customer
    const searchQuery = `SELECT * FROM Customer WHERE DisplayName = '${name.replace(/'/g, "\\'")}'`;
    const searchResult = await this.makeApiRequest('GET', `/query?query=${encodeURIComponent(searchQuery)}`);
    
    if (searchResult.QueryResponse?.Customer?.length > 0) {
      return searchResult.QueryResponse.Customer[0].Id;
    }

    // Create new customer
    const customerData = {
      DisplayName: name,
      PrimaryEmailAddr: email ? { Address: email } : undefined,
    };

    const createResult = await this.makeApiRequest('POST', '/customer', customerData);
    return createResult.Customer.Id;
  }

  /**
   * Find Item by name (e.g. "Automation:Labour")
   */
  private async findItemByName(name: string): Promise<string | null> {
    const escaped = name.replace(/'/g, "\\'");
    const query = `SELECT * FROM Item WHERE Name = '${escaped}'`;
    const result = await this.makeApiRequest('GET', `/query?query=${encodeURIComponent(query)}`);
    const items = result.QueryResponse?.Item;
    if (items && items.length > 0) {
      return items[0].Id;
    }
    return null;
  }

  /**
   * Find TaxCode by name (e.g. "GST")
   */
  private async findTaxCodeByName(name: string): Promise<string | null> {
    const escaped = name.replace(/'/g, "\\'");
    const query = `SELECT * FROM TaxCode WHERE Name = '${escaped}'`;
    const result = await this.makeApiRequest('GET', `/query?query=${encodeURIComponent(query)}`);
    const codes = result.QueryResponse?.TaxCode;
    if (codes && codes.length > 0) {
      return codes[0].Id;
    }
    return null;
  }

  /**
   * Create an invoice from grouped service tickets (CNRL format)
   * - Customer PO# custom field = PO value
   * - Reference custom field = approver code (G###)
   * - Line items: one per CC, "Automation:Labour", Description "CC: X Tickets: A, B, C", Qty 1, Rate = total, GST
   */
  async createInvoiceFromGroup(params: CreateInvoiceFromGroupParams): Promise<{ invoiceId: string; invoiceNumber: string }> {
    const customerId = await this.findOrCreateCustomer(params.customerName, params.customerEmail);
    const itemId = await this.findItemByName('Automation:Labour');
    const gstTaxCodeId = await this.findTaxCodeByName('GST');

    if (!itemId) {
      throw new Error('Item "Automation:Labour" not found in QuickBooks. Please create it first.');
    }

    const minorVersion = 75; // For custom fields support
    const lineItems = params.poAfeLineItems.map((item, index) => {
      const description = item.poAfe
        ? `PO/AFE/CC: ${item.poAfe} Tickets: ${item.tickets.join(', ')}`
        : `Tickets: ${item.tickets.join(', ')}`;
      const line: Record<string, unknown> = {
        Id: String(index + 1),
        LineNum: index + 1,
        Description: description,
        Amount: item.totalAmount,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: 1,
          UnitPrice: item.totalAmount,
        },
      };
      if (gstTaxCodeId) {
        (line.SalesItemLineDetail as Record<string, unknown>).TaxCodeRef = { value: gstTaxCodeId };
      }
      return line;
    });

    const invoiceData: Record<string, unknown> = {
      CustomerRef: { value: customerId },
      Line: lineItems,
      TxnDate: params.date,
      DocNumber: params.docNumber || undefined,
    };

    const customFields: Array<{ DefinitionId: string; StringValue: string }> = [];
    const customerPoDefId = process.env.QBO_CUSTOM_FIELD_CUSTOMER_PO;
    const referenceDefId = process.env.QBO_CUSTOM_FIELD_REFERENCE;
    if (customerPoDefId && params.customerPo) {
      customFields.push({ DefinitionId: customerPoDefId, StringValue: params.customerPo });
    }
    if (referenceDefId && params.reference) {
      customFields.push({ DefinitionId: referenceDefId, StringValue: params.reference });
    }
    if (customFields.length > 0) {
      invoiceData.CustomField = customFields;
    }

    const result = await this.makeApiRequest('POST', `/invoice?minorversion=${minorVersion}`, invoiceData);

    return {
      invoiceId: result.Invoice.Id,
      invoiceNumber: result.Invoice.DocNumber,
    };
  }

  /**
   * Create an invoice in QuickBooks
   */
  async createInvoice(params: CreateInvoiceParams): Promise<{ invoiceId: string; invoiceNumber: string }> {
    const customerId = await this.findOrCreateCustomer(params.customerName, params.customerEmail);

    const lineItems = params.lineItems.map((item, index) => ({
      Id: String(index + 1),
      LineNum: index + 1,
      Description: item.description,
      Amount: item.amount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        Qty: item.quantity || 1,
        UnitPrice: item.rate || item.amount,
      },
    }));

    const invoiceData = {
      CustomerRef: { value: customerId },
      Line: lineItems,
      TxnDate: params.date,
      DueDate: params.dueDate,
      DocNumber: params.ticketNumber, // Use ticket number as invoice reference
      CustomerMemo: params.memo ? { value: params.memo } : undefined,
    };

    const result = await this.makeApiRequest('POST', '/invoice', invoiceData);
    
    return {
      invoiceId: result.Invoice.Id,
      invoiceNumber: result.Invoice.DocNumber,
    };
  }

  /**
   * Attach a file (PDF) to an invoice
   */
  async attachFileToInvoice(invoiceId: string, pdfBuffer: Buffer, fileName: string): Promise<void> {
    const { accessToken, realmId } = await this.getValidAccessToken();
    
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    
    const metadata = JSON.stringify({
      AttachableRef: [
        {
          EntityRef: {
            type: 'Invoice',
            value: invoiceId,
          },
        },
      ],
      FileName: fileName,
      ContentType: 'application/pdf',
    });

    // Create multipart form data
    const parts: Buffer[] = [];
    
    // Add metadata part
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file_metadata"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${metadata}\r\n`
    ));
    
    // Add file part
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file_content"; filename="${fileName}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    ));
    parts.push(pdfBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    
    const body = Buffer.concat(parts);
    
    const url = `${QBO_API_BASE}/v3/company/${realmId}/upload`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Accept': 'application/json',
      },
      body: body,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to attach file: ${error}`);
    }
  }

  /**
   * Get invoice details
   */
  async getInvoice(invoiceId: string): Promise<any> {
    return this.makeApiRequest('GET', `/invoice/${invoiceId}`);
  }

  /**
   * Disconnect QuickBooks (remove tokens)
   */
  async disconnect(): Promise<void> {
    const { error } = await supabase
      .from('qbo_tokens')
      .delete()
      .eq('id', 'primary');

    if (error) {
      console.error('Error disconnecting QBO:', error);
      throw error;
    }
  }
}

export const quickbooksService = new QuickBooksService();
export default quickbooksService;
