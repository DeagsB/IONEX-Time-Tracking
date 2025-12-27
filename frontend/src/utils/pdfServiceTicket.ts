import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { ServiceTicket } from './serviceTickets';

// PDF page dimensions (Letter size)
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

// Maximum characters per description line
const MAX_DESCRIPTION_CHARS = 65;

// Layout coordinates based on the actual template
// Y coordinates are from bottom of page (PDF coordinate system)
// Recalibrated based on visual template analysis
const LAYOUT = {
  // Ticket number (after "Ticket:" label, top right)
  ticketNumber: { x: 545, y: 755 },
  
  // Customer section - data goes IN the white input boxes (right of labels)
  // Labels end around x=470, input boxes start at ~475
  customerName: { x: 478, y: 688 },      // In "Customer Name" input box
  billingAddress: { x: 478, y: 672 },    // In "Billing Address" input box
  contactName: { x: 478, y: 640 },       // In "Contact Name" input box
  contactPhone: { x: 478, y: 624 },      // In "Contact Phone" input box
  contactEmail: { x: 478, y: 608 },      // In "Contact Email" input box
  serviceLocation: { x: 478, y: 592 },   // In "Service Location" input box
  poCcAfe: { x: 478, y: 576 },           // In "PO/CC/AFE" input box
  
  // Service Info section (left side) - data goes in the input boxes
  jobId: { x: 108, y: 622 },             // In "Job ID" input box
  jobType: { x: 235, y: 622 },           // In "Job Type" input box
  techName: { x: 108, y: 604 },          // In "Tech" input box
  date: { x: 108, y: 586 },              // In "Date" input box
  
  // Service Description area - text inside the description box
  descriptionStartY: 532,
  descriptionRowHeight: 13,
  descriptionX: 75,                      // Left edge of description box
  descriptionMaxX: 400,                  // Right edge before hours columns
  maxDescriptionRows: 10,
  
  // Hours columns (RT, TT, FT, OT) - centered in each column header
  hoursColumns: {
    rt: { x: 430 },   // RT column center
    tt: { x: 462 },   // TT column center
    ft: { x: 494 },   // FT column center
    ot: { x: 526 },   // OT column center
  },
  
  // Total Time row
  totalsY: 395,
  totalTimeLabel: { x: 375 },
  
  // RT Rate and FT Rate (below description box, above Travel section)
  rtRateValue: { x: 145, y: 375 },       // After "RT Rate:"
  ftRateValue: { x: 290, y: 375 },       // After "FT Rate:"
  
  // Service Ticket Summary section (bottom right)
  summary: {
    totalRt: { x: 558, y: 248 },         // Right-aligned in Total RT row
    totalTt: { x: 558, y: 233 },         // Right-aligned in Total TT row
    totalFt: { x: 558, y: 218 },         // Right-aligned in Total FT row
    totalOt: { x: 558, y: 203 },         // Right-aligned in Total OT row
    totalExpenses: { x: 558, y: 188 },   // Right-aligned in Total Expenses row
    grandTotal: { x: 558, y: 168 },      // Right-aligned in TOTAL SERVICE TICKET row
  },
  
  // Customer Approval / Coding (bottom left)
  afeValue: { x: 105, y: 218 },          // After "AFE:"
  ccValue: { x: 105, y: 198 },           // After "CC:"
};

/**
 * Splits a description into multiple lines
 */
function splitDescription(description: string, maxChars: number): string[] {
  if (!description || description.length <= maxChars) {
    return [description || 'No description'];
  }

  const lines: string[] = [];
  let remaining = description;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      lines.push(remaining);
      break;
    }

    let breakPoint = maxChars;
    const lastSpace = remaining.lastIndexOf(' ', maxChars);
    
    if (lastSpace > maxChars * 0.5) {
      breakPoint = lastSpace;
    }

    lines.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }

  return lines;
}

interface RowItem {
  description: string;
  hours: number | null;
  rateType: string;
}

function prepareRowItems(entries: ServiceTicket['entries']): RowItem[] {
  const rowItems: RowItem[] = [];

  for (const entry of entries) {
    const descriptionLines = splitDescription(entry.description || 'No description', MAX_DESCRIPTION_CHARS);
    const rateType = entry.rate_type || 'Shop Time';

    for (let i = 0; i < descriptionLines.length; i++) {
      rowItems.push({
        description: descriptionLines[i],
        hours: i === 0 ? entry.hours : null,
        rateType: rateType,
      });
    }
  }

  return rowItems;
}

/**
 * Generate PDF service ticket using the template
 */
export async function generatePdfServiceTicket(ticket: ServiceTicket): Promise<Uint8Array> {
  // Try to load the template PDF
  let pdfDoc: PDFDocument;
  let templateLoaded = false;
  
  try {
    const templateResponse = await fetch('/templates/Service-Ticket-Example.pdf');
    if (templateResponse.ok) {
      const templateBytes = await templateResponse.arrayBuffer();
      pdfDoc = await PDFDocument.load(templateBytes);
      templateLoaded = true;
    } else {
      pdfDoc = await PDFDocument.create();
    }
  } catch {
    pdfDoc = await PDFDocument.create();
  }
  
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  
  // Prepare data
  const rowItems = prepareRowItems(ticket.entries);
  const maxRowsPerPage = LAYOUT.maxDescriptionRows;
  const totalPages = Math.max(1, Math.ceil(rowItems.length / maxRowsPerPage));
  
  // Calculate totals
  let rtTotal = 0, ttTotal = 0, ftTotal = 0, otTotal = 0;
  for (const entry of ticket.entries) {
    const rateType = entry.rate_type || 'Shop Time';
    if (rateType === 'Travel Time') {
      ttTotal += entry.hours;
    } else if (rateType === 'Field Time') {
      ftTotal += entry.hours;
    } else if (rateType === 'Shop Overtime' || rateType === 'Field Overtime') {
      otTotal += entry.hours;
    } else {
      rtTotal += entry.hours;
    }
  }
  
  // Rates
  const rtRate = 130, ttRate = 130, ftRate = 140, otRate = 195;
  const rtAmount = rtTotal * rtRate;
  const ttAmount = ttTotal * ttRate;
  const ftAmount = ftTotal * ftRate;
  const otAmount = otTotal * otRate;
  const grandTotal = rtAmount + ttAmount + ftAmount + otAmount;
  
  const customer = ticket.customerInfo;
  const ticketNumber = ticket.ticketNumber || `${ticket.userInitials}_${new Date().getFullYear() % 100}XXX`;
  
  let currentItemIndex = 0;
  
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    let page;
    
    if (templateLoaded) {
      if (pageNum === 1) {
        page = pdfDoc.getPages()[0];
      } else {
        const [copiedPage] = await pdfDoc.copyPages(pdfDoc, [0]);
        page = pdfDoc.addPage(copiedPage);
      }
    } else {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    }
    
    // === TICKET NUMBER (top right, after "Ticket:" label) ===
    const displayTicketNumber = totalPages > 1 ? `${ticketNumber} (${pageNum}/${totalPages})` : ticketNumber;
    page.drawText(displayTicketNumber, {
      x: LAYOUT.ticketNumber.x,
      y: LAYOUT.ticketNumber.y,
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // === CUSTOMER SECTION (right side - data in input boxes) ===
    page.drawText(customer.name || '', {
      x: LAYOUT.customerName.x,
      y: LAYOUT.customerName.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Billing Address - just the street address on first line
    page.drawText(customer.address || '', {
      x: LAYOUT.billingAddress.x,
      y: LAYOUT.billingAddress.y,
      size: 7,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Contact Name (employee who did the work)
    page.drawText(ticket.userName || '', {
      x: LAYOUT.contactName.x,
      y: LAYOUT.contactName.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(customer.phone || '', {
      x: LAYOUT.contactPhone.x,
      y: LAYOUT.contactPhone.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(customer.email || '', {
      x: LAYOUT.contactEmail.x,
      y: LAYOUT.contactEmail.y,
      size: 7,
      font,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(customer.service_location || customer.address || '', {
      x: LAYOUT.serviceLocation.x,
      y: LAYOUT.serviceLocation.y,
      size: 7,
      font,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(customer.po_number || '', {
      x: LAYOUT.poCcAfe.x,
      y: LAYOUT.poCcAfe.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    // === SERVICE INFO SECTION (left side) ===
    page.drawText(ticket.projectNumber || 'N/A', {
      x: LAYOUT.jobId.x,
      y: LAYOUT.jobId.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    page.drawText('AUTO', {
      x: LAYOUT.jobType.x,
      y: LAYOUT.jobType.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(ticket.userName || '', {
      x: LAYOUT.techName.x,
      y: LAYOUT.techName.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    const dateStr = new Date(ticket.date).toLocaleDateString('en-US', { 
      month: '2-digit', 
      day: '2-digit', 
      year: 'numeric' 
    });
    page.drawText(dateStr, {
      x: LAYOUT.date.x,
      y: LAYOUT.date.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    // === SERVICE DESCRIPTION ROWS ===
    let rowsOnThisPage = 0;
    
    while (currentItemIndex < rowItems.length && rowsOnThisPage < maxRowsPerPage) {
      const item = rowItems[currentItemIndex];
      const rowY = LAYOUT.descriptionStartY - (rowsOnThisPage * LAYOUT.descriptionRowHeight);
      
      // Description text
      page.drawText(item.description, {
        x: LAYOUT.descriptionX,
        y: rowY,
        size: 7,
        font,
        color: rgb(0, 0, 0),
      });
      
      // Hours in appropriate column
      if (item.hours !== null) {
        let hoursX = LAYOUT.hoursColumns.rt.x;
        
        if (item.rateType === 'Travel Time') {
          hoursX = LAYOUT.hoursColumns.tt.x;
        } else if (item.rateType === 'Field Time') {
          hoursX = LAYOUT.hoursColumns.ft.x;
        } else if (item.rateType === 'Shop Overtime' || item.rateType === 'Field Overtime') {
          hoursX = LAYOUT.hoursColumns.ot.x;
        }
        
        page.drawText(item.hours.toFixed(2), {
          x: hoursX,
          y: rowY,
          size: 8,
          font,
          color: rgb(0, 0, 0),
        });
      }
      
      currentItemIndex++;
      rowsOnThisPage++;
    }
    
    // === TOTALS ROW (Total Time) ===
    page.drawText(rtTotal.toFixed(2), {
      x: LAYOUT.hoursColumns.rt.x,
      y: LAYOUT.totalsY,
      size: 8,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(ttTotal.toFixed(2), {
      x: LAYOUT.hoursColumns.tt.x,
      y: LAYOUT.totalsY,
      size: 8,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(ftTotal.toFixed(2), {
      x: LAYOUT.hoursColumns.ft.x,
      y: LAYOUT.totalsY,
      size: 8,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(otTotal.toFixed(2), {
      x: LAYOUT.hoursColumns.ot.x,
      y: LAYOUT.totalsY,
      size: 8,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // Total hours sum (far right)
    const totalHours = rtTotal + ttTotal + ftTotal + otTotal;
    page.drawText(totalHours.toFixed(2), {
      x: 555,
      y: LAYOUT.totalsY,
      size: 8,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // === RT Rate and FT Rate values ===
    page.drawText(`$${rtRate.toFixed(2)}`, {
      x: LAYOUT.rtRateValue.x,
      y: LAYOUT.rtRateValue.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(`$${ftRate.toFixed(2)}`, {
      x: LAYOUT.ftRateValue.x,
      y: LAYOUT.ftRateValue.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    // === SERVICE TICKET SUMMARY (bottom right) ===
    if (pageNum === totalPages) {
      page.drawText(`$${rtAmount.toFixed(2)}`, {
        x: LAYOUT.summary.totalRt.x,
        y: LAYOUT.summary.totalRt.y,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      });
      
      page.drawText(`$${ttAmount.toFixed(2)}`, {
        x: LAYOUT.summary.totalTt.x,
        y: LAYOUT.summary.totalTt.y,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      });
      
      page.drawText(`$${ftAmount.toFixed(2)}`, {
        x: LAYOUT.summary.totalFt.x,
        y: LAYOUT.summary.totalFt.y,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      });
      
      page.drawText(`$${otAmount.toFixed(2)}`, {
        x: LAYOUT.summary.totalOt.x,
        y: LAYOUT.summary.totalOt.y,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      });
      
      page.drawText('$0.00', {
        x: LAYOUT.summary.totalExpenses.x,
        y: LAYOUT.summary.totalExpenses.y,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      });
      
      page.drawText(`$${grandTotal.toFixed(2)}`, {
        x: LAYOUT.summary.grandTotal.x,
        y: LAYOUT.summary.grandTotal.y,
        size: 9,
        font: boldFont,
        color: rgb(0, 0, 0),
      });
      
      // Customer Approval / Coding
      if (customer.po_number) {
        page.drawText(customer.po_number, {
          x: LAYOUT.afeValue.x,
          y: LAYOUT.afeValue.y,
          size: 8,
          font,
          color: rgb(0, 0, 0),
        });
      }
      
      if (customer.location_code) {
        page.drawText(customer.location_code, {
          x: LAYOUT.ccValue.x,
          y: LAYOUT.ccValue.y,
          size: 8,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }
  }
  
  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}

/**
 * Download the generated PDF
 */
export async function downloadPdfServiceTicket(ticket: ServiceTicket): Promise<void> {
  const pdfBytes = await generatePdfServiceTicket(ticket);
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  
  const ticketId = ticket.ticketNumber || 
    `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
  const fileName = `ServiceTicket_${ticketId}_${ticket.customerName.replace(/\s+/g, '_')}.pdf`;
  
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  
  URL.revokeObjectURL(url);
}
