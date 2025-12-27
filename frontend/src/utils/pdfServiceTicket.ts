import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { ServiceTicket } from './serviceTickets';

// PDF page dimensions (Letter size)
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

// Maximum characters per description line (matches Excel export)
const MAX_DESCRIPTION_CHARS = 75;

// Layout constants - based on Excel template measurements
// These coordinates are from the bottom-left of the PDF page
const LAYOUT = {
  // Ticket number (top right)
  ticketNumber: { x: 485, y: 755 },
  
  // Left side fields (Job Info section)
  jobId: { x: 85, y: 680 },        // C9
  techName: { x: 85, y: 665 },     // C10
  date: { x: 85, y: 650 },         // C11
  equipmentType: { x: 175, y: 680 }, // E9 - "AUTO"
  
  // Right side fields (Customer Info section)
  customerName: { x: 320, y: 710 },    // I3
  address: { x: 320, y: 695 },         // I4
  cityState: { x: 320, y: 680 },       // I5
  zipCode: { x: 320, y: 665 },         // I6
  contactName: { x: 320, y: 650 },     // I7
  phone: { x: 320, y: 635 },           // I8
  email: { x: 320, y: 620 },           // I9
  serviceLocation: { x: 320, y: 605 }, // I10
  locationCode: { x: 460, y: 605 },    // L10
  poNumber: { x: 320, y: 590 },        // I11
  approverName: { x: 460, y: 590 },    // L11
  
  // Service Description area
  descriptionStartY: 545,
  descriptionRowHeight: 15,
  descriptionX: 55,
  maxDescriptionRows: 10,
  
  // Hours columns (right side of description area)
  hoursColumns: {
    rt: { x: 420 },  // K column - Shop Time
    tt: { x: 455 },  // L column - Travel Time
    ft: { x: 490 },  // M column - Field Time
    ot: { x: 525 },  // N column - Overtime
  },
  
  // Totals row (row 24)
  totalsY: 390,
  
  // Summary section (bottom)
  summary: {
    rtAmount: { x: 490, y: 185 },    // M35
    ttAmount: { x: 490, y: 170 },    // M36
    ftAmount: { x: 490, y: 155 },    // M37
    otAmount: { x: 490, y: 140 },    // M38
    expenses: { x: 490, y: 125 },    // M39
    grandTotal: { x: 490, y: 105 },  // M40
  },
  
  // Footer fields
  footer: {
    poNumber: { x: 85, y: 140 },     // C37
    approverName: { x: 85, y: 170 }, // C35
  },
};

/**
 * Splits a description into multiple lines based on max character limit
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

/**
 * Represents a row item to be written
 */
interface RowItem {
  description: string;
  hours: number | null;
  rateType: string;
  isFirstLineOfEntry: boolean;
}

/**
 * Prepares row items from entries, splitting long descriptions
 */
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
        isFirstLineOfEntry: i === 0,
      });
    }
  }

  return rowItems;
}

/**
 * Generate PDF service ticket matching Excel format
 */
export async function generatePdfServiceTicket(ticket: ServiceTicket): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  
  // Embed fonts
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  
  // Prepare row items with split descriptions
  const rowItems = prepareRowItems(ticket.entries);
  const maxRowsPerPage = LAYOUT.maxDescriptionRows;
  const totalPages = Math.ceil(rowItems.length / maxRowsPerPage);
  
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
  
  // Create pages
  let currentItemIndex = 0;
  
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    
    // Draw page border
    page.drawRectangle({
      x: 30,
      y: 30,
      width: PAGE_WIDTH - 60,
      height: PAGE_HEIGHT - 60,
      borderColor: rgb(0, 0, 0),
      borderWidth: 1,
    });
    
    // Header section background
    page.drawRectangle({
      x: 30,
      y: PAGE_HEIGHT - 150,
      width: PAGE_WIDTH - 60,
      height: 120,
      color: rgb(0.95, 0.95, 0.95),
    });
    
    // Title
    page.drawText('SERVICE TICKET', {
      x: 220,
      y: PAGE_HEIGHT - 55,
      size: 18,
      font: boldFont,
      color: rgb(0, 0.4, 0),
    });
    
    // Ticket number with page indicator
    const displayTicketNumber = totalPages > 1 ? `${ticketNumber} (${pageNum}/${totalPages})` : ticketNumber;
    page.drawText(`Ticket: ${displayTicketNumber}`, {
      x: LAYOUT.ticketNumber.x - 50,
      y: LAYOUT.ticketNumber.y,
      size: 10,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // === LEFT SIDE (Job Info) ===
    page.drawText('JOB INFORMATION', {
      x: 50,
      y: 715,
      size: 9,
      font: boldFont,
      color: rgb(0, 0.4, 0),
    });
    
    // Job ID
    page.drawText('Job ID:', { x: 50, y: LAYOUT.jobId.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(ticket.projectNumber || 'N/A', { x: LAYOUT.jobId.x, y: LAYOUT.jobId.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Equipment Type
    page.drawText('Equipment:', { x: 145, y: LAYOUT.equipmentType.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText('AUTO', { x: LAYOUT.equipmentType.x, y: LAYOUT.equipmentType.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Tech Name
    page.drawText('Tech:', { x: 50, y: LAYOUT.techName.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(ticket.userName || '', { x: LAYOUT.techName.x, y: LAYOUT.techName.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Date
    page.drawText('Date:', { x: 50, y: LAYOUT.date.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    const dateStr = new Date(ticket.date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    page.drawText(dateStr, { x: LAYOUT.date.x, y: LAYOUT.date.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // === RIGHT SIDE (Customer Info) ===
    page.drawText('CUSTOMER INFORMATION', {
      x: 320,
      y: 725,
      size: 9,
      font: boldFont,
      color: rgb(0, 0.4, 0),
    });
    
    // Customer Name
    page.drawText(customer.name || '', { x: LAYOUT.customerName.x, y: LAYOUT.customerName.y, size: 9, font: boldFont, color: rgb(0, 0, 0) });
    
    // Address
    page.drawText(customer.address || '', { x: LAYOUT.address.x, y: LAYOUT.address.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // City, State
    const cityState = customer.city && customer.state ? `${customer.city}, ${customer.state}` : customer.city || customer.state || '';
    page.drawText(cityState, { x: LAYOUT.cityState.x, y: LAYOUT.cityState.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Zip Code
    page.drawText(customer.zip_code || '', { x: LAYOUT.zipCode.x, y: LAYOUT.zipCode.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Contact Name
    page.drawText('Contact:', { x: 280, y: LAYOUT.contactName.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(ticket.userName || '', { x: LAYOUT.contactName.x, y: LAYOUT.contactName.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Phone
    page.drawText('Phone:', { x: 280, y: LAYOUT.phone.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(customer.phone || '', { x: LAYOUT.phone.x, y: LAYOUT.phone.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Email
    page.drawText('Email:', { x: 280, y: LAYOUT.email.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(customer.email || '', { x: LAYOUT.email.x, y: LAYOUT.email.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Service Location
    page.drawText('Location:', { x: 280, y: LAYOUT.serviceLocation.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(customer.service_location || customer.address || '', { x: LAYOUT.serviceLocation.x, y: LAYOUT.serviceLocation.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Location Code
    if (customer.location_code) {
      page.drawText('Code:', { x: 440, y: LAYOUT.locationCode.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
      page.drawText(customer.location_code, { x: LAYOUT.locationCode.x, y: LAYOUT.locationCode.y, size: 8, font, color: rgb(0, 0, 0) });
    }
    
    // PO Number
    page.drawText('PO:', { x: 280, y: LAYOUT.poNumber.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(customer.po_number || '', { x: LAYOUT.poNumber.x, y: LAYOUT.poNumber.y, size: 8, font, color: rgb(0, 0, 0) });
    
    // Approver
    if (customer.approver_name) {
      page.drawText('Approver:', { x: 420, y: LAYOUT.approverName.y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
      page.drawText(customer.approver_name, { x: LAYOUT.approverName.x, y: LAYOUT.approverName.y, size: 8, font, color: rgb(0, 0, 0) });
    }
    
    // === SERVICE DESCRIPTION HEADER ===
    page.drawRectangle({
      x: 30,
      y: LAYOUT.descriptionStartY + 15,
      width: PAGE_WIDTH - 60,
      height: 20,
      color: rgb(0, 0.4, 0),
    });
    
    page.drawText('Service Description', { x: 55, y: LAYOUT.descriptionStartY + 20, size: 10, font: boldFont, color: rgb(1, 1, 1) });
    page.drawText('RT', { x: LAYOUT.hoursColumns.rt.x + 5, y: LAYOUT.descriptionStartY + 20, size: 9, font: boldFont, color: rgb(1, 1, 1) });
    page.drawText('TT', { x: LAYOUT.hoursColumns.tt.x + 5, y: LAYOUT.descriptionStartY + 20, size: 9, font: boldFont, color: rgb(1, 1, 1) });
    page.drawText('FT', { x: LAYOUT.hoursColumns.ft.x + 5, y: LAYOUT.descriptionStartY + 20, size: 9, font: boldFont, color: rgb(1, 1, 1) });
    page.drawText('OT', { x: LAYOUT.hoursColumns.ot.x + 5, y: LAYOUT.descriptionStartY + 20, size: 9, font: boldFont, color: rgb(1, 1, 1) });
    
    // === SERVICE DESCRIPTION ROWS ===
    let rowsOnThisPage = 0;
    let pageRtTotal = 0, pageTtTotal = 0, pageFtTotal = 0, pageOtTotal = 0;
    
    while (currentItemIndex < rowItems.length && rowsOnThisPage < maxRowsPerPage) {
      const item = rowItems[currentItemIndex];
      const rowY = LAYOUT.descriptionStartY - (rowsOnThisPage * LAYOUT.descriptionRowHeight) - 5;
      
      // Alternating row background
      if (rowsOnThisPage % 2 === 0) {
        page.drawRectangle({
          x: 30,
          y: rowY - 3,
          width: PAGE_WIDTH - 60,
          height: LAYOUT.descriptionRowHeight,
          color: rgb(0.97, 0.97, 0.97),
        });
      }
      
      // Description
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
          pageTtTotal += item.hours;
        } else if (item.rateType === 'Field Time') {
          hoursX = LAYOUT.hoursColumns.ft.x;
          pageFtTotal += item.hours;
        } else if (item.rateType === 'Shop Overtime' || item.rateType === 'Field Overtime') {
          hoursX = LAYOUT.hoursColumns.ot.x;
          pageOtTotal += item.hours;
        } else {
          pageRtTotal += item.hours;
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
    
    // === TOTALS ROW ===
    page.drawRectangle({
      x: 30,
      y: LAYOUT.totalsY - 5,
      width: PAGE_WIDTH - 60,
      height: 18,
      color: rgb(0.9, 0.9, 0.9),
    });
    
    page.drawText('Total Time', { x: 55, y: LAYOUT.totalsY, size: 9, font: boldFont, color: rgb(0, 0, 0) });
    
    // Show cumulative totals on last page, page totals otherwise
    const showRt = pageNum === totalPages ? rtTotal : pageRtTotal;
    const showTt = pageNum === totalPages ? ttTotal : pageTtTotal;
    const showFt = pageNum === totalPages ? ftTotal : pageFtTotal;
    const showOt = pageNum === totalPages ? otTotal : pageOtTotal;
    
    page.drawText(showRt.toFixed(2), { x: LAYOUT.hoursColumns.rt.x, y: LAYOUT.totalsY, size: 9, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(showTt.toFixed(2), { x: LAYOUT.hoursColumns.tt.x, y: LAYOUT.totalsY, size: 9, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(showFt.toFixed(2), { x: LAYOUT.hoursColumns.ft.x, y: LAYOUT.totalsY, size: 9, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(showOt.toFixed(2), { x: LAYOUT.hoursColumns.ot.x, y: LAYOUT.totalsY, size: 9, font: boldFont, color: rgb(0, 0, 0) });
    
    // === RATES LEGEND ===
    page.drawText('RT Rate: $130.00/hr', { x: 55, y: 360, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    page.drawText('TT Rate: $130.00/hr', { x: 160, y: 360, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    page.drawText('FT Rate: $140.00/hr', { x: 265, y: 360, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    page.drawText('OT Rate: $195.00/hr', { x: 370, y: 360, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    
    // === SUMMARY SECTION (only on last page) ===
    if (pageNum === totalPages) {
      // Summary box
      page.drawRectangle({
        x: 380,
        y: 80,
        width: 170,
        height: 130,
        borderColor: rgb(0, 0.4, 0),
        borderWidth: 1,
      });
      
      page.drawRectangle({
        x: 380,
        y: 185,
        width: 170,
        height: 25,
        color: rgb(0, 0.4, 0),
      });
      
      page.drawText('SERVICE TICKET SUMMARY', { x: 395, y: 192, size: 9, font: boldFont, color: rgb(1, 1, 1) });
      
      // Summary rows
      page.drawText('Regular Time (RT):', { x: 390, y: 168, size: 8, font, color: rgb(0, 0, 0) });
      page.drawText(`$${rtAmount.toFixed(2)}`, { x: LAYOUT.summary.rtAmount.x, y: 168, size: 8, font, color: rgb(0, 0, 0) });
      
      page.drawText('Travel Time (TT):', { x: 390, y: 153, size: 8, font, color: rgb(0, 0, 0) });
      page.drawText(`$${ttAmount.toFixed(2)}`, { x: LAYOUT.summary.ttAmount.x, y: 153, size: 8, font, color: rgb(0, 0, 0) });
      
      page.drawText('Field Time (FT):', { x: 390, y: 138, size: 8, font, color: rgb(0, 0, 0) });
      page.drawText(`$${ftAmount.toFixed(2)}`, { x: LAYOUT.summary.ftAmount.x, y: 138, size: 8, font, color: rgb(0, 0, 0) });
      
      page.drawText('Overtime (OT):', { x: 390, y: 123, size: 8, font, color: rgb(0, 0, 0) });
      page.drawText(`$${otAmount.toFixed(2)}`, { x: LAYOUT.summary.otAmount.x, y: 123, size: 8, font, color: rgb(0, 0, 0) });
      
      page.drawText('Expenses:', { x: 390, y: 108, size: 8, font, color: rgb(0, 0, 0) });
      page.drawText('$0.00', { x: LAYOUT.summary.expenses.x, y: 108, size: 8, font, color: rgb(0, 0, 0) });
      
      // Grand total line
      page.drawLine({
        start: { x: 385, y: 98 },
        end: { x: 545, y: 98 },
        thickness: 1,
        color: rgb(0, 0.4, 0),
      });
      
      page.drawText('GRAND TOTAL:', { x: 390, y: 85, size: 10, font: boldFont, color: rgb(0, 0.4, 0) });
      page.drawText(`$${grandTotal.toFixed(2)}`, { x: LAYOUT.summary.grandTotal.x - 10, y: 85, size: 10, font: boldFont, color: rgb(0, 0.4, 0) });
      
      // Footer section
      page.drawText('Approved By:', { x: 55, y: 170, size: 8, font: boldFont, color: rgb(0, 0, 0) });
      page.drawText(customer.approver_name || '_________________', { x: 110, y: 170, size: 8, font, color: rgb(0, 0, 0) });
      
      page.drawText('PO Number:', { x: 55, y: 150, size: 8, font: boldFont, color: rgb(0, 0, 0) });
      page.drawText(customer.po_number || '_________________', { x: 110, y: 150, size: 8, font, color: rgb(0, 0, 0) });
      
      page.drawText('Signature:', { x: 55, y: 110, size: 8, font: boldFont, color: rgb(0, 0, 0) });
      page.drawLine({
        start: { x: 100, y: 108 },
        end: { x: 250, y: 108 },
        thickness: 0.5,
        color: rgb(0, 0, 0),
      });
      
      page.drawText('Date:', { x: 260, y: 110, size: 8, font: boldFont, color: rgb(0, 0, 0) });
      page.drawLine({
        start: { x: 285, y: 108 },
        end: { x: 360, y: 108 },
        thickness: 0.5,
        color: rgb(0, 0, 0),
      });
    }
    
    // Page number
    page.drawText(`Page ${pageNum} of ${totalPages}`, {
      x: PAGE_WIDTH / 2 - 25,
      y: 45,
      size: 8,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
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
