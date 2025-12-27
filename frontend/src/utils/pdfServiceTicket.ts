import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { ServiceTicket } from './serviceTickets';

// PDF page dimensions (Letter size)
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

// Maximum characters per description line
const MAX_DESCRIPTION_CHARS = 70;

// Layout coordinates based on the actual template
// Y coordinates are from bottom of page
const LAYOUT = {
  // Ticket number (top right, next to "Ticket:")
  ticketNumber: { x: 530, y: 740 },
  
  // Customer section (right side)
  customerName: { x: 385, y: 693 },
  billingAddress: { x: 385, y: 678 },
  contactName: { x: 385, y: 648 },
  contactPhone: { x: 385, y: 633 },
  contactEmail: { x: 385, y: 618 },
  serviceLocation: { x: 385, y: 603 },
  poCcAfe: { x: 385, y: 588 },
  
  // Service Info section (left side)
  jobId: { x: 95, y: 608 },
  jobType: { x: 175, y: 608 },
  techName: { x: 95, y: 588 },
  date: { x: 95, y: 570 },
  
  // Service Description area
  descriptionStartY: 528,
  descriptionRowHeight: 13,
  descriptionX: 52,
  maxDescriptionRows: 10,
  
  // Hours columns (based on template)
  hoursColumns: {
    rt: { x: 448 },  // RT column
    tt: { x: 480 },  // TT column
    ft: { x: 512 },  // FT column
    ot: { x: 545 },  // OT column
  },
  
  // Totals row (Total Time row)
  totalsY: 378,
  
  // RT Rate and FT Rate labels
  rtRateY: 363,
  rtRateX: 95,
  ftRateX: 195,
  
  // Service Ticket Summary section
  summary: {
    totalRt: { x: 545, y: 258 },
    totalTt: { x: 545, y: 243 },
    totalFt: { x: 545, y: 228 },
    totalOt: { x: 545, y: 213 },
    totalExpenses: { x: 545, y: 198 },
    grandTotal: { x: 545, y: 178 },
  },
  
  // Customer Approval / Coding
  afeValue: { x: 95, y: 233 },
  ccValue: { x: 95, y: 213 },
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
        // Use the first page of the template
        page = pdfDoc.getPages()[0];
      } else {
        // Copy the template page for additional pages
        const [copiedPage] = await pdfDoc.copyPages(pdfDoc, [0]);
        page = pdfDoc.addPage(copiedPage);
      }
    } else {
      // Create a blank page if no template
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    }
    
    // === TICKET NUMBER ===
    const displayTicketNumber = totalPages > 1 ? `${ticketNumber} (${pageNum}/${totalPages})` : ticketNumber;
    page.drawText(displayTicketNumber, {
      x: LAYOUT.ticketNumber.x,
      y: LAYOUT.ticketNumber.y,
      size: 10,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // === CUSTOMER SECTION (right side) ===
    // Customer Name
    page.drawText(customer.name || '', {
      x: LAYOUT.customerName.x,
      y: LAYOUT.customerName.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Billing Address (combine address, city, state, zip)
    const billingAddress = [
      customer.address,
      customer.city && customer.state ? `${customer.city}, ${customer.state}` : customer.city || customer.state,
      customer.zip_code
    ].filter(Boolean).join(' ');
    
    page.drawText(billingAddress || '', {
      x: LAYOUT.billingAddress.x,
      y: LAYOUT.billingAddress.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Contact Name
    page.drawText(ticket.userName || '', {
      x: LAYOUT.contactName.x,
      y: LAYOUT.contactName.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Contact Phone
    page.drawText(customer.phone || '', {
      x: LAYOUT.contactPhone.x,
      y: LAYOUT.contactPhone.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Contact Email
    page.drawText(customer.email || '', {
      x: LAYOUT.contactEmail.x,
      y: LAYOUT.contactEmail.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Service Location
    page.drawText(customer.service_location || customer.address || '', {
      x: LAYOUT.serviceLocation.x,
      y: LAYOUT.serviceLocation.y,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    // PO/CC/AFE
    page.drawText(customer.po_number || '', {
      x: LAYOUT.poCcAfe.x,
      y: LAYOUT.poCcAfe.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // === SERVICE INFO SECTION (left side) ===
    // Job ID
    page.drawText(ticket.projectNumber || 'N/A', {
      x: LAYOUT.jobId.x,
      y: LAYOUT.jobId.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Job Type (Equipment - always AUTO)
    page.drawText('AUTO', {
      x: LAYOUT.jobType.x,
      y: LAYOUT.jobType.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Tech Name
    page.drawText(ticket.userName || '', {
      x: LAYOUT.techName.x,
      y: LAYOUT.techName.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Date
    const dateStr = new Date(ticket.date).toLocaleDateString('en-US', { 
      month: '2-digit', 
      day: '2-digit', 
      year: 'numeric' 
    });
    page.drawText(dateStr, {
      x: LAYOUT.date.x,
      y: LAYOUT.date.y,
      size: 9,
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
        size: 8,
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
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(ttTotal.toFixed(2), {
      x: LAYOUT.hoursColumns.tt.x,
      y: LAYOUT.totalsY,
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(ftTotal.toFixed(2), {
      x: LAYOUT.hoursColumns.ft.x,
      y: LAYOUT.totalsY,
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(otTotal.toFixed(2), {
      x: LAYOUT.hoursColumns.ot.x,
      y: LAYOUT.totalsY,
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // Total hours sum
    const totalHours = rtTotal + ttTotal + ftTotal + otTotal;
    page.drawText(totalHours.toFixed(2), {
      x: 545,
      y: LAYOUT.totalsY,
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // === RT Rate and FT Rate values ===
    page.drawText(`$${rtRate.toFixed(2)}`, {
      x: LAYOUT.rtRateX,
      y: LAYOUT.rtRateY,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    page.drawText(`$${ftRate.toFixed(2)}`, {
      x: LAYOUT.ftRateX,
      y: LAYOUT.rtRateY,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    });
    
    // === SERVICE TICKET SUMMARY (only meaningful values on last page) ===
    if (pageNum === totalPages) {
      // Total RT
      page.drawText(`$${rtAmount.toFixed(2)}`, {
        x: LAYOUT.summary.totalRt.x,
        y: LAYOUT.summary.totalRt.y,
        size: 9,
        font,
        color: rgb(0, 0, 0),
      });
      
      // Total TT
      page.drawText(`$${ttAmount.toFixed(2)}`, {
        x: LAYOUT.summary.totalTt.x,
        y: LAYOUT.summary.totalTt.y,
        size: 9,
        font,
        color: rgb(0, 0, 0),
      });
      
      // Total FT
      page.drawText(`$${ftAmount.toFixed(2)}`, {
        x: LAYOUT.summary.totalFt.x,
        y: LAYOUT.summary.totalFt.y,
        size: 9,
        font,
        color: rgb(0, 0, 0),
      });
      
      // Total OT
      page.drawText(`$${otAmount.toFixed(2)}`, {
        x: LAYOUT.summary.totalOt.x,
        y: LAYOUT.summary.totalOt.y,
        size: 9,
        font,
        color: rgb(0, 0, 0),
      });
      
      // Total Expenses
      page.drawText('$0.00', {
        x: LAYOUT.summary.totalExpenses.x,
        y: LAYOUT.summary.totalExpenses.y,
        size: 9,
        font,
        color: rgb(0, 0, 0),
      });
      
      // Grand Total
      page.drawText(`$${grandTotal.toFixed(2)}`, {
        x: LAYOUT.summary.grandTotal.x,
        y: LAYOUT.summary.grandTotal.y,
        size: 10,
        font: boldFont,
        color: rgb(0, 0, 0),
      });
      
      // Customer Approval / Coding
      // AFE value (use PO number)
      if (customer.po_number) {
        page.drawText(customer.po_number, {
          x: LAYOUT.afeValue.x,
          y: LAYOUT.afeValue.y,
          size: 9,
          font,
          color: rgb(0, 0, 0),
        });
      }
      
      // CC value (use location code or leave blank)
      if (customer.location_code) {
        page.drawText(customer.location_code, {
          x: LAYOUT.ccValue.x,
          y: LAYOUT.ccValue.y,
          size: 9,
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
