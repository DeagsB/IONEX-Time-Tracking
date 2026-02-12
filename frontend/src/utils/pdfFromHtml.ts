import html2pdf from 'html2pdf.js';
import { PDFDocument } from 'pdf-lib';
import { ServiceTicket, getApproverPoAfeFromTicket } from './serviceTickets';
import { supabase } from '../lib/supabaseClient';

interface PdfExportResult {
  blob: Blob;
  filename: string;
  storageUrl?: string;
}

// Map database rate types to column codes
const RATE_TYPE_MAP: { [key: string]: 'RT' | 'TT' | 'FT' | 'OT' } = {
  'Shop Time': 'RT',
  'Travel Time': 'TT', 
  'Field Time': 'FT',
  'Shop Overtime': 'OT',
  'Field Overtime': 'OT',
};

const getRateCode = (rateType?: string): 'RT' | 'TT' | 'FT' | 'OT' => {
  return RATE_TYPE_MAP[rateType || ''] || 'RT';
};

// Round UP to nearest 0.5 hour (never round down)
const roundToHalfHour = (hours: number): number => {
  return Math.ceil(hours * 2) / 2;
};

/** Wait for layout and images so html2canvas captures complete content.
 * html2canvas fails to render off-screen elements correctly. */
async function waitForPdfElementReady(element: HTMLElement | null): Promise<void> {
  if (!element) return;
  const img = element.querySelector('img');
  if (img && !img.complete) {
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
      setTimeout(resolve, 3000);
    });
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

// Generate PDF from HTML that matches the Excel template exactly
export async function downloadPdfFromHtml(
  ticket: ServiceTicket,
  expenses: Array<{
    expense_type: string;
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  }> = []
): Promise<void> {
  // Calculate totals using mapped rate types (each entry rounded to nearest 0.5)
  const rtHours = ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'RT' ? roundToHalfHour(e.hours) : 0), 0);
  const ttHours = ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'TT' ? roundToHalfHour(e.hours) : 0), 0);
  const ftHours = ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'FT' ? roundToHalfHour(e.hours) : 0), 0);
  const otHours = ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'OT' ? roundToHalfHour(e.hours) : 0), 0);

  // Use employee-specific rates from ticket
  const rtRate = ticket.rates.rt;
  const ttRate = ticket.rates.tt;
  const ftRate = ticket.rates.ft;
  const shopOtRate = ticket.rates.shop_ot;
  const fieldOtRate = ticket.rates.field_ot;

  // Calculate OT amounts separately (for standalone tickets use hoursByRateType)
  const shopOtHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (e.rate_type === 'Shop Overtime' ? roundToHalfHour(e.hours) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Shop Overtime'] || 0);
  const fieldOtHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (e.rate_type === 'Field Overtime' ? roundToHalfHour(e.hours) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Field Overtime'] || 0);
  const shopOtAmount = shopOtHours * shopOtRate;
  const fieldOtAmount = fieldOtHours * fieldOtRate;

  const rtAmount = rtHours * rtRate;
  const ttAmount = ttHours * ttRate;
  const ftAmount = ftHours * ftRate;
  const otAmount = shopOtAmount + fieldOtAmount;
  const expensesTotal = expenses.reduce((sum, e) => sum + (e.quantity * e.rate), 0);
  const grandTotal = rtAmount + ttAmount + ftAmount + otAmount + expensesTotal;

  // Format date
  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear()}`;
  };

  // Group entries by description (notes only; no date in PDF service description)
  const descriptionLines: { text: string; st: number; tt: number; ft: number; so: number; fo: number }[] = [];
  ticket.entries.forEach(entry => {
    const desc = entry.description || 'Work performed';
    const rateCode = getRateCode(entry.rate_type);
    const roundedHours = roundToHalfHour(entry.hours);
    descriptionLines.push({
      text: desc, // Show full description without truncating
      st: rateCode === 'RT' ? roundedHours : 0,
      tt: rateCode === 'TT' ? roundedHours : 0,
      ft: rateCode === 'FT' ? roundedHours : 0,
      so: entry.rate_type === 'Shop Overtime' ? roundedHours : 0,
      fo: entry.rate_type === 'Field Overtime' ? roundedHours : 0,
    });
  });

  // Pad to 10 rows minimum
  while (descriptionLines.length < 10) {
    descriptionLines.push({ text: '', st: 0, tt: 0, ft: 0, so: 0, fo: 0 });
  }

  // Get employee name and email from first entry
  const employeeName = ticket.entries[0]?.user?.first_name && ticket.entries[0]?.user?.last_name
    ? `${ticket.entries[0].user.first_name} ${ticket.entries[0].user.last_name}`
    : ticket.userName || 'Unknown';
  const employeeEmail = ticket.entries[0]?.user?.email || '';

  const ticketDate = ticket.entries[0]?.date ? formatDate(ticket.entries[0].date) : formatDate(new Date().toISOString());
  const approverPoAfe = ticket.customerInfo.approver_name ?? ticket.customerInfo.po_number ?? ticket.projectApproverPoAfe ?? '';

  const html = `
    <div id="service-ticket" style="
      width: 8.5in;
      font-family: Arial, sans-serif;
      font-size: 9pt;
      color: #000;
      background: #fff;
      padding: 0.3in;
      box-sizing: border-box;
    ">
      <!-- Header -->
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <div style="width: 180px;">
          <img 
            src="/ionex-logo.png" 
            alt="IONEX Systems" 
            style="max-width: 180px; max-height: 60px; height: auto;" 
            onerror="this.onerror=null; this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22180%22 height=%2250%22><text x=%220%22 y=%2235%22 font-family=%22Arial%22 font-size=%2224%22 font-weight=%22bold%22 fill=%22%23cc0000%22>IONEX</text></svg>';"
          />
        </div>
        <div style="flex: 1; text-align: center;">
          <div style="font-size: 16pt; font-weight: bold; letter-spacing: 2px;">SERVICE TICKET</div>
        </div>
        <div style="width: 140px; text-align: right;">
          <div style="font-size: 8pt; color: #666;">Ticket:</div>
          <div style="font-size: 11pt; font-weight: bold; border: 1px solid #000; padding: 4px 8px; display: inline-block; background: #f5f5f5;">
            ${ticket.ticketNumber || ticket.id.substring(0, 8).toUpperCase()}
          </div>
        </div>
      </div>

      <!-- Customer Info and Service Info Row -->
      <div style="display: flex; gap: 10px; margin-bottom: 10px;">
        <!-- Service Info (Left) -->
        <div style="flex: 1; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000;">Service Info</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 8pt;">
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; width: 60px;">Job ID</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; border-right: 1px solid #ccc;">${ticket.projectNumber || ''}</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; width: 60px;">Job Type</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">AUTO</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Tech</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${employeeName}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Email</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${employeeEmail}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Date</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticketDate}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Address</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">2-3650 19th Street NE</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">City</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Calgary, AB</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px;">Postal</td>
              <td colspan="3" style="padding: 2px 4px;">T2E 6V2</td>
            </tr>
          </table>
        </div>

        <!-- Customer Info (Right) -->
        <div style="flex: 1.2; border: 1px solid #000;">
          <table style="width: 100%; border-collapse: collapse; font-size: 8pt;">
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; width: 100px;">Customer Name</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc; font-weight: bold;">${ticket.customerInfo.name}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Billing Address</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.address || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">City/Province</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.city || ''}${ticket.customerInfo.state ? ', ' + ticket.customerInfo.state : ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Postal Code</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.zip_code || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Contact Name</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.contact_name || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Contact Phone</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.phone || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Contact Email</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.email || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Service Location</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.service_location || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; width: 100px;">PO/CC/AFE</td>
              <td style="padding: 2px 4px; border-right: 1px solid #ccc;">${approverPoAfe}</td>
              <td style="padding: 2px 4px; width: 40px;">Other</td>
              <td style="padding: 2px 4px;">${ticket.projectOther ?? ticket.customerInfo.location_code ?? ''}</td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Service Description (table for aligned ST, FT, TT, SO, FO columns) -->
      <div style="border: 1px solid #000; margin-bottom: 10px;">
        <table style="width: 100%; border-collapse: collapse; table-layout: fixed;">
          <colgroup>
            <col style="width: auto;" />
            <col style="width: 40px;" />
            <col style="width: 40px;" />
            <col style="width: 40px;" />
            <col style="width: 40px;" />
            <col style="width: 40px;" />
          </colgroup>
          <thead>
            <tr style="background: #e0e0e0; font-weight: bold; border-bottom: 1px solid #000;">
              <td style="padding: 3px 6px;">Service Description</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">ST</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">FT</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">TT</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">SO</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">FO</td>
            </tr>
          </thead>
          <tbody>
            ${descriptionLines.map(line => `
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 2px 4px; font-size: 8pt; height: 20px; vertical-align: top; box-sizing: border-box;">${line.text || '&nbsp;'}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.st || ''}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.ft || ''}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.tt || ''}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.so || ''}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.fo || ''}</td>
            </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr style="border-top: 2px solid #000; background: #f5f5f5; font-weight: bold;">
              <td style="padding: 4px 6px; text-align: right;">Total Time</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${rtHours || ''}</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${ftHours || ''}</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${ttHours || ''}</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${shopOtHours || ''}</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${fieldOtHours || ''}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- Rates Row -->
      <div style="display: flex; gap: 20px; margin-bottom: 10px; font-size: 8pt;">
        <div><strong>Shop Time (ST) Rate:</strong> $${rtRate.toFixed(2)}</div>
        <div><strong>Field Time (FT) Rate:</strong> $${ftRate.toFixed(2)}</div>
        <div><strong>Travel Time (TT) Rate:</strong> $${ttRate.toFixed(2)}</div>
        <div><strong>Shop OT (SO) Rate:</strong> $${shopOtRate.toFixed(2)}</div>
        <div><strong>Field OT (FO) Rate:</strong> $${fieldOtRate.toFixed(2)}</div>
      </div>

      <!-- Travel/Expenses and Summary Row -->
      <div style="display: flex; gap: 10px; margin-bottom: 10px;">
        <!-- Travel/Expenses (single table, no spacer, so no gap below Total Expenses) -->
        <div style="flex: 1; border: 1px solid #000; display: flex; flex-direction: column;">
          <table style="width: 100%; border-collapse: collapse; table-layout: fixed; flex: 1;">
            <colgroup>
              <col style="width: auto;" />
              <col style="width: 60px;" />
              <col style="width: 40px;" />
              <col style="width: 60px;" />
            </colgroup>
            <thead>
              <tr style="background: #e0e0e0; font-weight: bold; border-bottom: 1px solid #000;">
                <td style="padding: 3px 6px;">Travel / Subsistence / Expenses / Equipment</td>
                <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">RATE</td>
                <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">QTY</td>
                <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">SUB</td>
              </tr>
            </thead>
            <tbody>
              ${expenses.length > 0 ? expenses.map((expense) => `
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 2px 4px; font-size: 8pt; height: 20px; vertical-align: top; box-sizing: border-box;">${expense.description}${expense.unit ? ` (${expense.unit})` : ''}</td>
                <td style="padding: 2px 4px; text-align: right; font-size: 8pt; height: 20px; border-left: 1px solid #ccc; vertical-align: middle; box-sizing: border-box;">$${expense.rate.toFixed(2)}</td>
                <td style="padding: 2px 4px; text-align: center; font-size: 8pt; height: 20px; border-left: 1px solid #ccc; vertical-align: middle; box-sizing: border-box;">${expense.quantity.toFixed(2)}</td>
                <td style="padding: 2px 4px; text-align: right; font-size: 8pt; height: 20px; border-left: 1px solid #ccc; vertical-align: middle; box-sizing: border-box;">$${(expense.quantity * expense.rate).toFixed(2)}</td>
              </tr>
              `).join('') : ''}
              ${Array.from({ length: Math.max(0, 6 - expenses.length) }).map(() => `
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 2px 4px; height: 20px; vertical-align: top; box-sizing: border-box;">&nbsp;</td>
                <td style="padding: 2px; height: 20px; border-left: 1px solid #ccc; box-sizing: border-box;"></td>
                <td style="padding: 2px; height: 20px; border-left: 1px solid #ccc; box-sizing: border-box;"></td>
                <td style="padding: 2px; height: 20px; border-left: 1px solid #ccc; box-sizing: border-box;"></td>
              </tr>
              `).join('')}
            </tbody>
            <tfoot>
              <tr style="border-top: 2px solid #000; font-weight: bold; background: #f0f0f0;">
                <td style="padding: 4px 6px; text-align: right; vertical-align: bottom;">Total Expenses</td>
                <td style="padding: 4px 4px; border-left: 1px solid #000; vertical-align: bottom;"></td>
                <td style="padding: 4px 4px; border-left: 1px solid #000; vertical-align: bottom;"></td>
                <td style="padding: 4px 6px; border-left: 1px solid #000; text-align: right; vertical-align: bottom; font-size: 10pt;">$${expensesTotal.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Service Ticket Summary -->
        <div style="width: 200px; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000;">Service Ticket Summary</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 8pt;">
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total ST</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${rtAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total FT</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${ftAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total TT</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${ttAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total SO</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${shopOtAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total FO</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${fieldOtAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total Expenses</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${expensesTotal.toFixed(2)}</td>
            </tr>
            <tr style="background: #f0f0f0;">
              <td style="padding: 4px 6px; font-weight: bold;">TOTAL</td>
              <td style="padding: 4px 6px; text-align: right; font-weight: bold; font-size: 10pt;">$${grandTotal.toFixed(2)}</td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Customer Approval / Coding Row -->
      <div style="display: flex; gap: 10px; margin-bottom: 10px;">
        <div style="flex: 1; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000;">Customer Approval / Coding</div>
          <div style="padding: 20px 6px; font-size: 8pt;">
          </div>
        </div>
        <div style="flex: 1; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000;">Customer Signature</div>
          <div style="padding: 20px 6px; font-size: 8pt;">
            <div style="border-bottom: 1px solid #000; margin-bottom: 4px; height: 20px;"></div>
            <div>Signature</div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div style="text-align: center; font-size: 7pt; color: #666; margin-top: 10px; border-top: 1px solid #ccc; padding-top: 6px;">
        IONEX Systems | Calgary, Alberta | Email: accounting@ionexsystems.com
      </div>
    </div>
  `;

  // Create a temporary container - must be in viewport for html2canvas to capture correctly
  // (off-screen elements at -9999px cause missing/incomplete content in merged PDFs)
  const container = document.createElement('div');
  container.innerHTML = html;
  container.style.cssText = 'position:fixed;left:0;top:0;width:8.5in;z-index:-1;pointer-events:none;opacity:0.01';
  document.body.appendChild(container);

  const element = container.querySelector('#service-ticket');

  try {
    await waitForPdfElementReady(element as HTMLElement);
    const opt = {
      margin: 0,
      filename: `ServiceTicket_${ticket.ticketNumber || ticket.id.substring(0, 8)}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { 
        scale: 3,
        useCORS: true,
        logging: false,
      },
      jsPDF: { 
        unit: 'in', 
        format: 'letter', 
        orientation: 'portrait' as const
      }
    };

    await html2pdf().set(opt).from(element).save();
  } finally {
    document.body.removeChild(container);
  }
}

/**
 * Generate PDF and optionally upload to Supabase Storage
 * Returns the PDF blob and storage URL if uploaded
 */
export async function generateAndStorePdf(
  ticket: ServiceTicket,
  expenses: Array<{
    expense_type: string;
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  }> = [],
  options: {
    uploadToStorage?: boolean;
    downloadLocally?: boolean;
  } = { uploadToStorage: false, downloadLocally: true }
): Promise<PdfExportResult> {
  // Calculate totals using mapped rate types (each entry rounded to nearest 0.5)
  // For standalone tickets with no entries, use hoursByRateType
  const rtHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'RT' ? roundToHalfHour(e.hours) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Shop Time'] || 0);
  const ttHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'TT' ? roundToHalfHour(e.hours) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Travel Time'] || 0);
  const ftHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'FT' ? roundToHalfHour(e.hours) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Field Time'] || 0);

  // Use employee-specific rates from ticket
  const rtRate = ticket.rates.rt;
  const ttRate = ticket.rates.tt;
  const ftRate = ticket.rates.ft;
  const shopOtRate = ticket.rates.shop_ot;
  const fieldOtRate = ticket.rates.field_ot;

  // Calculate OT amounts separately (for standalone tickets use hoursByRateType)
  const shopOtHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (e.rate_type === 'Shop Overtime' ? roundToHalfHour(e.hours) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Shop Overtime'] || 0);
  const fieldOtHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (e.rate_type === 'Field Overtime' ? roundToHalfHour(e.hours) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Field Overtime'] || 0);
  const shopOtAmount = shopOtHours * shopOtRate;
  const fieldOtAmount = fieldOtHours * fieldOtRate;

  const rtAmount = rtHours * rtRate;
  const ttAmount = ttHours * ttRate;
  const ftAmount = ftHours * ftRate;
  const otAmount = shopOtAmount + fieldOtAmount;
  const expensesTotal = expenses.reduce((sum, e) => sum + (e.quantity * e.rate), 0);
  const grandTotal = rtAmount + ttAmount + ftAmount + otAmount + expensesTotal;

  // Format date
  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear()}`;
  };

  // Group entries by description (notes only; no date in PDF service description)
  // For standalone tickets with no entries, build from hoursByRateType
  const descriptionLines: { text: string; st: number; tt: number; ft: number; so: number; fo: number }[] = [];
  if (ticket.entries.length > 0) {
    ticket.entries.forEach(entry => {
      const desc = entry.description || 'Work performed';
      const rateCode = getRateCode(entry.rate_type);
      const roundedHours = roundToHalfHour(entry.hours);
      descriptionLines.push({
        text: desc,
        st: rateCode === 'RT' ? roundedHours : 0,
        tt: rateCode === 'TT' ? roundedHours : 0,
        ft: rateCode === 'FT' ? roundedHours : 0,
        so: entry.rate_type === 'Shop Overtime' ? roundedHours : 0,
        fo: entry.rate_type === 'Field Overtime' ? roundedHours : 0,
      });
    });
  } else {
    // Standalone ticket: build one row from hoursByRateType
    const st = roundToHalfHour(ticket.hoursByRateType['Shop Time'] || 0);
    const tt = roundToHalfHour(ticket.hoursByRateType['Travel Time'] || 0);
    const ft = roundToHalfHour(ticket.hoursByRateType['Field Time'] || 0);
    const so = roundToHalfHour(ticket.hoursByRateType['Shop Overtime'] || 0);
    const fo = roundToHalfHour(ticket.hoursByRateType['Field Overtime'] || 0);
    if (st + tt + ft + so + fo > 0) {
      descriptionLines.push({ text: 'Work performed', st, tt, ft, so, fo });
    }
  }

  // Pad to 10 rows minimum
  while (descriptionLines.length < 10) {
    descriptionLines.push({ text: '', st: 0, tt: 0, ft: 0, so: 0, fo: 0 });
  }

  // Get employee name and email from first entry
  const employeeName = ticket.entries[0]?.user?.first_name && ticket.entries[0]?.user?.last_name
    ? `${ticket.entries[0].user.first_name} ${ticket.entries[0].user.last_name}`
    : ticket.userName || 'Unknown';
  const employeeEmail = ticket.entries[0]?.user?.email || '';

  const ticketDate = ticket.entries[0]?.date ? formatDate(ticket.entries[0].date) : formatDate(new Date().toISOString());
  const filename = `ServiceTicket_${ticket.ticketNumber || ticket.id.substring(0, 8)}.pdf`;

  // Build the same HTML as downloadPdfFromHtml (abbreviated for space)
  const headerOverrides = (ticket as ServiceTicket & { headerOverrides?: { approver_po_afe?: string } }).headerOverrides;
  const html = buildPdfHtml(ticket, expenses, descriptionLines, employeeName, employeeEmail, ticketDate, rtHours, ttHours, ftHours, shopOtHours, fieldOtHours, rtRate, ttRate, ftRate, shopOtRate, fieldOtRate, rtAmount, ttAmount, ftAmount, shopOtAmount, fieldOtAmount, expensesTotal, grandTotal, headerOverrides);

  // Create a temporary container - must be in viewport for html2canvas to capture correctly
  // (off-screen elements at -9999px cause missing/incomplete content in merged PDFs)
  const container = document.createElement('div');
  container.innerHTML = html;
  container.style.cssText = 'position:fixed;left:0;top:0;width:8.5in;z-index:-1;pointer-events:none;opacity:0.01';
  document.body.appendChild(container);

  const element = container.querySelector('#service-ticket');

  try {
    await waitForPdfElementReady(element as HTMLElement);
    const opt = {
      margin: 0,
      filename: filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { 
        scale: 3,
        useCORS: true,
        logging: false,
      },
      jsPDF: { 
        unit: 'in', 
        format: 'letter', 
        orientation: 'portrait' as const
      }
    };

    // Generate PDF as blob
    const pdfBlob = await html2pdf().set(opt).from(element).outputPdf('blob') as Blob;
    
    let storageUrl: string | undefined;
    
    // Upload to Supabase Storage if requested
    if (options.uploadToStorage) {
      const storagePath = `service-tickets/${new Date().getFullYear()}/${ticket.ticketNumber || ticket.id}/${filename}`;
      
      const { error } = await supabase.storage
        .from('service-ticket-pdfs')
        .upload(storagePath, pdfBlob, {
          contentType: 'application/pdf',
          upsert: true,
        });
      
      if (error) {
        console.error('Error uploading PDF to storage:', error);
      } else {
        // Get public URL
        const { data: urlData } = supabase.storage
          .from('service-ticket-pdfs')
          .getPublicUrl(storagePath);
        storageUrl = urlData?.publicUrl;
      }
    }
    
    // Download locally if requested
    if (options.downloadLocally) {
      const url = URL.createObjectURL(pdfBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    }
    
    return {
      blob: pdfBlob,
      filename,
      storageUrl,
    };
  } finally {
    document.body.removeChild(container);
  }
}

/**
 * Merge multiple PDF blobs into a single PDF.
 * Uses pdf-lib to copy pages from each source into a new document.
 */
export async function mergePdfBlobs(blobs: Blob[]): Promise<Blob> {
  const mergedPdf = await PDFDocument.create();
  for (const blob of blobs) {
    const bytes = await blob.arrayBuffer();
    const pdf = await PDFDocument.load(bytes);
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach((p) => mergedPdf.addPage(p));
  }
  const mergedBytes = await mergedPdf.save();
  return new Blob([mergedBytes as BlobPart], { type: 'application/pdf' });
}

/**
 * Helper function to build the PDF HTML content
 */
function buildPdfHtml(
  ticket: ServiceTicket,
  expenses: Array<{ expense_type: string; description: string; quantity: number; rate: number; unit?: string }>,
  descriptionLines: { text: string; st: number; tt: number; ft: number; so: number; fo: number }[],
  employeeName: string,
  employeeEmail: string,
  ticketDate: string,
  rtHours: number,
  ttHours: number,
  ftHours: number,
  shopOtHours: number,
  fieldOtHours: number,
  rtRate: number,
  ttRate: number,
  ftRate: number,
  shopOtRate: number,
  fieldOtRate: number,
  rtAmount: number,
  ttAmount: number,
  ftAmount: number,
  shopOtAmount: number,
  fieldOtAmount: number,
  expensesTotal: number,
  grandTotal: number,
  headerOverrides?: { approver_po_afe?: string } | null
): string {
  // Use same resolution as Invoices grouping so PO/CC/AFE displays correctly in merged exports
  const approverPoAfe = headerOverrides != null
    ? getApproverPoAfeFromTicket(ticket, headerOverrides)
    : (ticket.customerInfo.approver_name ?? ticket.customerInfo.po_number ?? ticket.projectApproverPoAfe ?? '');
  return `
    <div id="service-ticket" style="
      width: 8.5in;
      font-family: Arial, sans-serif;
      font-size: 9pt;
      color: #000;
      background: #fff;
      padding: 0.3in;
      box-sizing: border-box;
    ">
      <!-- Header -->
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <div style="width: 180px;">
          <img 
            src="/ionex-logo.png" 
            alt="IONEX Systems" 
            style="max-width: 180px; max-height: 60px; height: auto;" 
            onerror="this.onerror=null; this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22180%22 height=%2250%22><text x=%220%22 y=%2235%22 font-family=%22Arial%22 font-size=%2224%22 font-weight=%22bold%22 fill=%22%23cc0000%22>IONEX</text></svg>';"
          />
        </div>
        <div style="flex: 1; text-align: center;">
          <div style="font-size: 16pt; font-weight: bold; letter-spacing: 2px;">SERVICE TICKET</div>
        </div>
        <div style="width: 140px; text-align: right;">
          <div style="font-size: 8pt; color: #666;">Ticket:</div>
          <div style="font-size: 11pt; font-weight: bold; border: 1px solid #000; padding: 4px 8px; display: inline-block; background: #f5f5f5;">
            ${ticket.ticketNumber || ticket.id.substring(0, 8).toUpperCase()}
          </div>
        </div>
      </div>

      <!-- Customer Info and Service Info Row -->
      <div style="display: flex; gap: 10px; margin-bottom: 10px;">
        <!-- Service Info (Left) -->
        <div style="flex: 1; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000;">Service Info</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 8pt;">
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; width: 60px;">Job ID</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; border-right: 1px solid #ccc;">${ticket.projectNumber || ''}</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; width: 60px;">Job Type</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">AUTO</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Tech</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${employeeName}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Email</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${employeeEmail}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Date</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticketDate}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Address</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">2-3650 19th Street NE</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">City</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Calgary, AB</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px;">Postal</td>
              <td colspan="3" style="padding: 2px 4px;">T2E 6V2</td>
            </tr>
          </table>
        </div>

        <!-- Customer Info (Right) -->
        <div style="flex: 1.2; border: 1px solid #000;">
          <table style="width: 100%; border-collapse: collapse; font-size: 8pt;">
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; width: 100px;">Customer Name</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc; font-weight: bold;">${ticket.customerInfo.name}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Billing Address</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.address || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">City/Province</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.city || ''}${ticket.customerInfo.state ? ', ' + ticket.customerInfo.state : ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Postal Code</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.zip_code || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Contact Name</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.contact_name || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Contact Phone</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.phone || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Contact Email</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.email || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Service Location</td>
              <td colspan="3" style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.service_location || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; width: 100px;">PO/CC/AFE</td>
              <td style="padding: 2px 4px; border-right: 1px solid #ccc;">${approverPoAfe}</td>
              <td style="padding: 2px 4px; width: 40px;">Other</td>
              <td style="padding: 2px 4px;">${ticket.projectOther ?? ticket.customerInfo.location_code ?? ''}</td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Service Description (table for aligned ST, FT, TT, SO, FO columns) -->
      <div style="border: 1px solid #000; margin-bottom: 10px;">
        <table style="width: 100%; border-collapse: collapse; table-layout: fixed;">
          <colgroup>
            <col style="width: auto;" />
            <col style="width: 40px;" />
            <col style="width: 40px;" />
            <col style="width: 40px;" />
            <col style="width: 40px;" />
            <col style="width: 40px;" />
          </colgroup>
          <thead>
            <tr style="background: #e0e0e0; font-weight: bold; border-bottom: 1px solid #000;">
              <td style="padding: 3px 6px;">Service Description</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">ST</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">FT</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">TT</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">SO</td>
              <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">FO</td>
            </tr>
          </thead>
          <tbody>
            ${descriptionLines.map(line => `
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 2px 4px; font-size: 8pt; height: 20px; vertical-align: top; box-sizing: border-box;">${line.text || '&nbsp;'}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.st || ''}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.ft || ''}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.tt || ''}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.so || ''}</td>
              <td style="padding: 2px; text-align: center; border-left: 1px solid #ccc; height: 20px; vertical-align: middle; box-sizing: border-box;">${line.fo || ''}</td>
            </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr style="border-top: 2px solid #000; background: #f5f5f5; font-weight: bold;">
              <td style="padding: 4px 6px; text-align: right;">Total Time</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${rtHours || ''}</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${ftHours || ''}</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${ttHours || ''}</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${shopOtHours || ''}</td>
              <td style="padding: 4px; text-align: center; border-left: 1px solid #000;">${fieldOtHours || ''}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- Rates Row -->
      <div style="display: flex; gap: 20px; margin-bottom: 10px; font-size: 8pt;">
        <div><strong>Shop Time (ST) Rate:</strong> $${rtRate.toFixed(2)}</div>
        <div><strong>Field Time (FT) Rate:</strong> $${ftRate.toFixed(2)}</div>
        <div><strong>Travel Time (TT) Rate:</strong> $${ttRate.toFixed(2)}</div>
        <div><strong>Shop OT (SO) Rate:</strong> $${shopOtRate.toFixed(2)}</div>
        <div><strong>Field OT (FO) Rate:</strong> $${fieldOtRate.toFixed(2)}</div>
      </div>

      <!-- Travel/Expenses and Summary Row -->
      <div style="display: flex; gap: 10px; margin-bottom: 10px;">
        <!-- Travel/Expenses (single table, no spacer, so no gap below Total Expenses) -->
        <div style="flex: 1; border: 1px solid #000; display: flex; flex-direction: column;">
          <table style="width: 100%; border-collapse: collapse; table-layout: fixed; flex: 1;">
            <colgroup>
              <col style="width: auto;" />
              <col style="width: 60px;" />
              <col style="width: 40px;" />
              <col style="width: 60px;" />
            </colgroup>
            <thead>
              <tr style="background: #e0e0e0; font-weight: bold; border-bottom: 1px solid #000;">
                <td style="padding: 3px 6px;">Travel / Subsistence / Expenses / Equipment</td>
                <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">RATE</td>
                <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">QTY</td>
                <td style="padding: 3px; text-align: center; border-left: 1px solid #000;">SUB</td>
              </tr>
            </thead>
            <tbody>
              ${expenses.length > 0 ? expenses.map((expense) => `
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 2px 4px; font-size: 8pt; height: 20px; vertical-align: top; box-sizing: border-box;">${expense.description}${expense.unit ? ` (${expense.unit})` : ''}</td>
                <td style="padding: 2px 4px; text-align: right; font-size: 8pt; height: 20px; border-left: 1px solid #ccc; vertical-align: middle; box-sizing: border-box;">$${expense.rate.toFixed(2)}</td>
                <td style="padding: 2px 4px; text-align: center; font-size: 8pt; height: 20px; border-left: 1px solid #ccc; vertical-align: middle; box-sizing: border-box;">${expense.quantity.toFixed(2)}</td>
                <td style="padding: 2px 4px; text-align: right; font-size: 8pt; height: 20px; border-left: 1px solid #ccc; vertical-align: middle; box-sizing: border-box;">$${(expense.quantity * expense.rate).toFixed(2)}</td>
              </tr>
              `).join('') : ''}
              ${Array.from({ length: Math.max(0, 6 - expenses.length) }).map(() => `
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 2px 4px; height: 20px; vertical-align: top; box-sizing: border-box;">&nbsp;</td>
                <td style="padding: 2px; height: 20px; border-left: 1px solid #ccc; box-sizing: border-box;"></td>
                <td style="padding: 2px; height: 20px; border-left: 1px solid #ccc; box-sizing: border-box;"></td>
                <td style="padding: 2px; height: 20px; border-left: 1px solid #ccc; box-sizing: border-box;"></td>
              </tr>
              `).join('')}
            </tbody>
            <tfoot>
              <tr style="border-top: 2px solid #000; font-weight: bold; background: #f0f0f0;">
                <td style="padding: 4px 6px; text-align: right; vertical-align: bottom;">Total Expenses</td>
                <td style="padding: 4px 4px; border-left: 1px solid #000; vertical-align: bottom;"></td>
                <td style="padding: 4px 4px; border-left: 1px solid #000; vertical-align: bottom;"></td>
                <td style="padding: 4px 6px; border-left: 1px solid #000; text-align: right; vertical-align: bottom; font-size: 10pt;">$${expensesTotal.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Service Ticket Summary -->
        <div style="width: 200px; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000;">Service Ticket Summary</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 8pt;">
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total ST</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${rtAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total FT</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${ftAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total TT</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${ttAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total SO</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${shopOtAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total FO</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${fieldOtAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total Expenses</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${expensesTotal.toFixed(2)}</td>
            </tr>
            <tr style="background: #f0f0f0;">
              <td style="padding: 4px 6px; font-weight: bold;">TOTAL</td>
              <td style="padding: 4px 6px; text-align: right; font-weight: bold; font-size: 10pt;">$${grandTotal.toFixed(2)}</td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Customer Approval / Coding Row -->
      <div style="display: flex; gap: 10px; margin-bottom: 10px;">
        <div style="flex: 1; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000;">Customer Approval / Coding</div>
          <div style="padding: 20px 6px; font-size: 8pt;">
          </div>
        </div>
        <div style="flex: 1; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000;">Customer Signature</div>
          <div style="padding: 20px 6px; font-size: 8pt;">
            <div style="border-bottom: 1px solid #000; margin-bottom: 4px; height: 20px;"></div>
            <div>Signature</div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div style="text-align: center; font-size: 7pt; color: #666; margin-top: 10px; border-top: 1px solid #ccc; padding-top: 6px;">
        IONEX Systems | Calgary, Alberta | Email: accounting@ionexsystems.com
      </div>
    </div>
  `;
}
