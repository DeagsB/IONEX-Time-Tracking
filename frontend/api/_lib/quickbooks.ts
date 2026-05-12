/**
 * QuickBooks Online server-side service for Vercel API routes.
 * Mirrors backend/src/services/quickbooksService.ts so behaviour matches the
 * (currently undeployed) Express backend. Token storage uses the same
 * `qbo_tokens` Supabase table.
 *
 * Required Vercel env vars:
 *   SUPABASE_URL              — same as VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY      — service-role key (server only)
 *   QBO_CLIENT_ID
 *   QBO_CLIENT_SECRET
 *   QBO_REDIRECT_URI          — https://<vercel-domain>/api/quickbooks/callback
 *   QBO_ENVIRONMENT           — "sandbox" or "production"
 *   FRONTEND_URL              — https://<vercel-domain> (callback redirect target)
 *   QBO_CUSTOM_FIELD_CUSTOMER_PO  — optional, DefinitionId for invoice custom field
 *   QBO_CUSTOM_FIELD_REFERENCE    — optional, DefinitionId for invoice custom field
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || '';
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || '';
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI || '';
const QBO_ENVIRONMENT = process.env.QBO_ENVIRONMENT || 'sandbox';

const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_API_BASE = QBO_ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

export interface QBOTokens {
  access_token: string;
  refresh_token: string;
  realm_id: string;
  expires_at: Date;
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

export function getAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    redirect_uri: QBO_REDIRECT_URI,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state,
  });
  return `${QBO_AUTH_URL}?${params.toString()}`;
}

async function storeTokens(tokens: QBOTokens): Promise<void> {
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

async function getStoredTokens(): Promise<QBOTokens | null> {
  const { data, error } = await supabase
    .from('qbo_tokens')
    .select('*')
    .eq('id', 'primary')
    .single();
  if (error || !data) return null;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    realm_id: data.realm_id,
    expires_at: new Date(data.expires_at),
  };
}

export async function exchangeCodeForTokens(code: string, realmId: string): Promise<QBOTokens> {
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
      code,
      redirect_uri: QBO_REDIRECT_URI,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${error}`);
  }
  const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  const tokens: QBOTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    realm_id: realmId,
    expires_at: new Date(Date.now() + data.expires_in * 1000),
  };
  await storeTokens(tokens);
  return tokens;
}

async function refreshAccessToken(): Promise<QBOTokens> {
  const storedTokens = await getStoredTokens();
  if (!storedTokens) throw new Error('No stored tokens found. Please re-authorize.');
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
  const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  const tokens: QBOTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    realm_id: storedTokens.realm_id,
    expires_at: new Date(Date.now() + data.expires_in * 1000),
  };
  await storeTokens(tokens);
  return tokens;
}

async function getValidAccessToken(): Promise<{ accessToken: string; realmId: string }> {
  let tokens = await getStoredTokens();
  if (!tokens) throw new Error('QuickBooks not connected. Please authorize first.');
  // Refresh if token expires within 5 minutes
  if (tokens.expires_at <= new Date(Date.now() + 5 * 60 * 1000)) {
    tokens = await refreshAccessToken();
  }
  return { accessToken: tokens.access_token, realmId: tokens.realm_id };
}

export async function isConnected(): Promise<boolean> {
  const tokens = await getStoredTokens();
  return tokens !== null;
}

async function makeApiRequest(method: 'GET' | 'POST' | 'PUT' | 'DELETE', endpoint: string, body?: unknown): Promise<any> {
  const { accessToken, realmId } = await getValidAccessToken();
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

async function findOrCreateCustomer(name: string, email?: string): Promise<string> {
  const searchQuery = `SELECT * FROM Customer WHERE DisplayName = '${name.replace(/'/g, "\\'")}'`;
  const searchResult = await makeApiRequest('GET', `/query?query=${encodeURIComponent(searchQuery)}`);
  if (searchResult.QueryResponse?.Customer?.length > 0) {
    return searchResult.QueryResponse.Customer[0].Id;
  }
  const customerData = {
    DisplayName: name,
    PrimaryEmailAddr: email ? { Address: email } : undefined,
  };
  const createResult = await makeApiRequest('POST', '/customer', customerData);
  return createResult.Customer.Id;
}

async function findItemByName(name: string): Promise<string | null> {
  const escaped = name.replace(/'/g, "\\'");
  const query = `SELECT * FROM Item WHERE Name = '${escaped}'`;
  const result = await makeApiRequest('GET', `/query?query=${encodeURIComponent(query)}`);
  const items = result.QueryResponse?.Item;
  return items?.[0]?.Id ?? null;
}

async function findTaxCodeByName(name: string): Promise<string | null> {
  const escaped = name.replace(/'/g, "\\'");
  const query = `SELECT * FROM TaxCode WHERE Name = '${escaped}'`;
  const result = await makeApiRequest('GET', `/query?query=${encodeURIComponent(query)}`);
  const codes = result.QueryResponse?.TaxCode;
  return codes?.[0]?.Id ?? null;
}

export async function createInvoiceFromGroup(params: CreateInvoiceFromGroupParams): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const customerId = await findOrCreateCustomer(params.customerName, params.customerEmail);
  const itemId = await findItemByName('Automation:Labour');
  const gstTaxCodeId = await findTaxCodeByName('GST');

  if (!itemId) {
    throw new Error('Item "Automation:Labour" not found in QuickBooks. Please create it first.');
  }

  const minorVersion = 75; // custom-field support
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

  const result = await makeApiRequest('POST', `/invoice?minorversion=${minorVersion}`, invoiceData);
  return {
    invoiceId: result.Invoice.Id,
    invoiceNumber: result.Invoice.DocNumber,
  };
}

export async function attachFileToInvoice(invoiceId: string, pdfBuffer: Buffer, fileName: string): Promise<void> {
  const { accessToken, realmId } = await getValidAccessToken();
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const metadata = JSON.stringify({
    AttachableRef: [{ EntityRef: { type: 'Invoice', value: invoiceId } }],
    FileName: fileName,
    ContentType: 'application/pdf',
  });
  const parts: Buffer[] = [];
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file_metadata"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${metadata}\r\n`
  ));
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
    body,
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to attach file: ${error}`);
  }
}

export async function getInvoice(invoiceId: string): Promise<any> {
  return makeApiRequest('GET', `/invoice/${invoiceId}`);
}

export async function downloadInvoicePdf(invoiceId: string): Promise<Buffer> {
  const { accessToken, realmId } = await getValidAccessToken();
  const url = `${QBO_API_BASE}/v3/company/${realmId}/invoice/${invoiceId}/pdf`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/pdf',
    },
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`QuickBooks API error fetching invoice PDF: ${response.status} ${errText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function disconnect(): Promise<void> {
  const { error } = await supabase
    .from('qbo_tokens')
    .delete()
    .eq('id', 'primary');
  if (error) {
    console.error('Error disconnecting QBO:', error);
    throw error;
  }
}
