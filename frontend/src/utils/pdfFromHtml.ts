import html2pdf from 'html2pdf.js';
import { ServiceTicket } from './serviceTickets';

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

// Generate PDF from HTML that matches the Excel template exactly
export async function downloadPdfFromHtml(ticket: ServiceTicket): Promise<void> {
  // Calculate totals using mapped rate types (each entry rounded to nearest 0.5)
  const rtHours = ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'RT' ? roundToHalfHour(e.hours) : 0), 0);
  const ttHours = ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'TT' ? roundToHalfHour(e.hours) : 0), 0);
  const ftHours = ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'FT' ? roundToHalfHour(e.hours) : 0), 0);
  const otHours = ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'OT' ? roundToHalfHour(e.hours) : 0), 0);

  const rtRate = 110;
  const ttRate = 85;
  const ftRate = 140;
  const otRate = 165;

  const rtAmount = rtHours * rtRate;
  const ttAmount = ttHours * ttRate;
  const ftAmount = ftHours * ftRate;
  const otAmount = otHours * otRate;
  const grandTotal = rtAmount + ttAmount + ftAmount + otAmount;

  // Format date
  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear()}`;
  };

  // Group entries by description (date + notes), round hours to nearest 0.5
  const descriptionLines: { text: string; rt: number; tt: number; ft: number; ot: number }[] = [];
  ticket.entries.forEach(entry => {
    const dateStr = formatDate(entry.date);
    const desc = `${dateStr} - ${entry.description || 'Work performed'}`;
    const rateCode = getRateCode(entry.rate_type);
    const roundedHours = roundToHalfHour(entry.hours);
    descriptionLines.push({
      text: desc.substring(0, 60),
      rt: rateCode === 'RT' ? roundedHours : 0,
      tt: rateCode === 'TT' ? roundedHours : 0,
      ft: rateCode === 'FT' ? roundedHours : 0,
      ot: rateCode === 'OT' ? roundedHours : 0,
    });
  });

  // Pad to 10 rows minimum
  while (descriptionLines.length < 10) {
    descriptionLines.push({ text: '', rt: 0, tt: 0, ft: 0, ot: 0 });
  }

  // Get employee name from first entry
  const employeeName = ticket.entries[0]?.user?.first_name && ticket.entries[0]?.user?.last_name
    ? `${ticket.entries[0].user.first_name} ${ticket.entries[0].user.last_name}`
    : ticket.userName || 'Unknown';

  const ticketDate = ticket.entries[0]?.date ? formatDate(ticket.entries[0].date) : formatDate(new Date().toISOString());

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
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
        <div style="width: 200px;">
          <img src="/ionex-logo.png" alt="IONEX" style="width: 180px; height: auto;" onerror="this.style.display='none'" />
          <div style="font-size: 18pt; font-weight: bold; color: #c00; margin-top: 5px;">IONEX</div>
        </div>
        <div style="text-align: center; flex: 1;">
          <div style="font-size: 14pt; font-weight: bold;">SERVICE TICKET</div>
        </div>
        <div style="text-align: right; width: 120px;">
          <div style="font-size: 8pt; color: #666;">Ticket:</div>
          <div style="font-size: 11pt; font-weight: bold; border: 1px solid #000; padding: 2px 6px; display: inline-block;">
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
              <td style="padding: 2px 4px;">Date</td>
              <td colspan="3" style="padding: 2px 4px;">${ticketDate}</td>
            </tr>
          </table>
        </div>

        <!-- Customer Info (Right) -->
        <div style="flex: 1.2; border: 1px solid #000;">
          <table style="width: 100%; border-collapse: collapse; font-size: 8pt;">
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; width: 100px;">Customer Name</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc; font-weight: bold;">${ticket.customerInfo.name}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Billing Address</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.address || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">City/Province</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.city || ''}${ticket.customerInfo.state ? ', ' + ticket.customerInfo.state : ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Postal Code</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.zip_code || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Contact Name</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.approver_name || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Contact Phone</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.phone || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Contact Email</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.email || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">Service Location</td>
              <td style="padding: 2px 4px; border-bottom: 1px solid #ccc;">${ticket.customerInfo.service_location || ''}</td>
            </tr>
            <tr>
              <td style="padding: 2px 4px;">PO/CC/AFE</td>
              <td style="padding: 2px 4px;">${ticket.customerInfo.po_number || ''}</td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Service Description -->
      <div style="border: 1px solid #000; margin-bottom: 10px;">
        <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000; display: flex;">
          <div style="flex: 1;">Service Description</div>
          <div style="width: 40px; text-align: center; border-left: 1px solid #000;">RT</div>
          <div style="width: 40px; text-align: center; border-left: 1px solid #000;">TT</div>
          <div style="width: 40px; text-align: center; border-left: 1px solid #000;">FT</div>
          <div style="width: 40px; text-align: center; border-left: 1px solid #000;">OT</div>
        </div>
        ${descriptionLines.map(line => `
          <div style="display: flex; border-bottom: 1px solid #eee; min-height: 16px;">
            <div style="flex: 1; padding: 2px 4px; font-size: 8pt;">${line.text}</div>
            <div style="width: 40px; text-align: center; border-left: 1px solid #ccc; padding: 2px;">${line.rt || ''}</div>
            <div style="width: 40px; text-align: center; border-left: 1px solid #ccc; padding: 2px;">${line.tt || ''}</div>
            <div style="width: 40px; text-align: center; border-left: 1px solid #ccc; padding: 2px;">${line.ft || ''}</div>
            <div style="width: 40px; text-align: center; border-left: 1px solid #ccc; padding: 2px;">${line.ot || ''}</div>
          </div>
        `).join('')}
        <!-- Totals row -->
        <div style="display: flex; border-top: 2px solid #000; background: #f5f5f5; font-weight: bold;">
          <div style="flex: 1; padding: 4px 6px; text-align: right;">Total Time</div>
          <div style="width: 40px; text-align: center; border-left: 1px solid #000; padding: 4px;">${rtHours || ''}</div>
          <div style="width: 40px; text-align: center; border-left: 1px solid #000; padding: 4px;">${ttHours || ''}</div>
          <div style="width: 40px; text-align: center; border-left: 1px solid #000; padding: 4px;">${ftHours || ''}</div>
          <div style="width: 40px; text-align: center; border-left: 1px solid #000; padding: 4px;">${otHours || ''}</div>
        </div>
      </div>

      <!-- Rates Row -->
      <div style="display: flex; gap: 20px; margin-bottom: 10px; font-size: 8pt;">
        <div><strong>RT Rate:</strong> $${rtRate.toFixed(2)}</div>
        <div><strong>TT Rate:</strong> $${ttRate.toFixed(2)}</div>
        <div><strong>FT Rate:</strong> $${ftRate.toFixed(2)}</div>
        <div><strong>OT Rate:</strong> $${otRate.toFixed(2)}</div>
      </div>

      <!-- Travel/Expenses and Summary Row -->
      <div style="display: flex; gap: 10px; margin-bottom: 10px;">
        <!-- Travel/Expenses -->
        <div style="flex: 1; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000; display: flex;">
            <div style="flex: 1;">Travel / Subsistence / Expenses / Equipment</div>
            <div style="width: 60px; text-align: center; border-left: 1px solid #000;">RATE</div>
            <div style="width: 40px; text-align: center; border-left: 1px solid #000;">QTY</div>
            <div style="width: 60px; text-align: center; border-left: 1px solid #000;">SUB</div>
          </div>
          ${[1, 2, 3, 4].map(() => `
            <div style="display: flex; min-height: 16px; border-bottom: 1px solid #eee;">
              <div style="flex: 1; padding: 2px 4px;"></div>
              <div style="width: 60px; border-left: 1px solid #ccc;"></div>
              <div style="width: 40px; border-left: 1px solid #ccc;"></div>
              <div style="width: 60px; border-left: 1px solid #ccc;"></div>
            </div>
          `).join('')}
          <div style="display: flex; border-top: 1px solid #000; font-weight: bold;">
            <div style="flex: 1; padding: 4px 6px; text-align: right;">Total Expenses</div>
            <div style="width: 60px; border-left: 1px solid #000; padding: 4px; text-align: center;">$0.00</div>
          </div>
        </div>

        <!-- Service Ticket Summary -->
        <div style="width: 200px; border: 1px solid #000;">
          <div style="background: #e0e0e0; padding: 3px 6px; font-weight: bold; border-bottom: 1px solid #000;">Service Ticket Summary</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 8pt;">
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total RT</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${rtAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total TT</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${ttAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total FT</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${ftAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total OT</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$${otAmount.toFixed(2)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ccc;">
              <td style="padding: 3px 6px;">Total Expenses</td>
              <td style="padding: 3px 6px; text-align: right; font-weight: bold;">$0.00</td>
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
          <div style="padding: 6px; font-size: 8pt;">
            <div style="margin-bottom: 4px;"><strong>AFE:</strong> ${ticket.customerInfo.po_number || '_________________'}</div>
            <div><strong>CC:</strong> _________________</div>
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
        IONEX Oilfield Services | Calgary, Alberta | Phone: (403) 555-1234 | Email: service@ionex.ca
      </div>
    </div>
  `;

  // Create a temporary container
  const container = document.createElement('div');
  container.innerHTML = html;
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.style.top = '-9999px';
  document.body.appendChild(container);

  const element = container.querySelector('#service-ticket');

  try {
    const opt = {
      margin: 0,
      filename: `ServiceTicket_${ticket.ticketNumber || ticket.id.substring(0, 8)}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { 
        scale: 2,
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
