import { PDFDocument, PDFPage, PDFFont, rgb } from 'pdf-lib';
import { ServiceTicket } from './serviceTickets';

// PDF coordinate system: (0,0) is bottom-left
// Template dimensions based on standard letter size (612 x 792 points)
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

// Excel column to PDF X coordinate conversion
// Excel columns are ~47 points wide starting at x=36
const excelColToX = (col: string): number => {
  const colIndex = col.charCodeAt(0) - 'A'.charCodeAt(0);
  return 36 + (colIndex * 47);
};

// Excel row to PDF Y coordinate conversion (row 1 is at top)
const excelRowToY = (row: number): number => {
  return PAGE_HEIGHT - (row * 15.5); // ~15.5 points per Excel row
};

// Field coordinates based on Excel template structure
const LAYOUT = {
  // Ticket number (M1)
  ticketNumber: { x: excelColToX('M'), y: excelRowToY(1) },
  
  // Customer info (column H, rows 3-11)
  customerName: { x: excelColToX('H'), y: excelRowToY(3) },
  billingAddress: { x: excelColToX('H'), y: excelRowToY(4) },
  contactName: { x: excelColToX('H'), y: excelRowToY(7) },
  contactPhone: { x: excelColToX('H'), y: excelRowToY(8) },
  contactEmail: { x: excelColToX('H'), y: excelRowToY(9) },
  serviceLocation: { x: excelColToX('H'), y: excelRowToY(10) },
  poAfeCc: { x: excelColToX('H'), y: excelRowToY(11) },
  
  // Service info (left side)
  jobId: { x: excelColToX('C'), y: excelRowToY(9) },
  jobType: { x: excelColToX('E'), y: excelRowToY(9) },
  tech: { x: excelColToX('C'), y: excelRowToY(10) },
  date: { x: excelColToX('C'), y: excelRowToY(11) },
  
  // Service description box (rows 14-23, 10 rows available)
  descriptionBox: {
    x: excelColToX('B'),
    y: excelRowToY(24), // Bottom of box
    width: 400,
    height: 155, // 10 rows * 15.5
    startY: excelRowToY(14), // First data row
    rowHeight: 15.5,
    maxRows: 10, // Rows 14-23
  },
  
  // Column X positions for time entries (row 13 headers: K, L, M, N)
  columns: {
    description: excelColToX('B'),
    rt: excelColToX('K'),
    tt: excelColToX('L'),
    ft: excelColToX('M'),
    ot: excelColToX('N'),
  },
  
  // Totals row (row 24, columns K-N)
  totals: {
    y: excelRowToY(24),
    rt: excelColToX('K'),
    tt: excelColToX('L'),
    ft: excelColToX('M'),
    ot: excelColToX('N'),
  },
  
  // Summary section (column I, rows 35-40)
  summary: {
    x: excelColToX('I'),
    totalRT: { y: excelRowToY(35) },
    totalTT: { y: excelRowToY(36) },
    totalFT: { y: excelRowToY(37) },
    totalOT: { y: excelRowToY(38) },
    totalExpenses: { y: excelRowToY(39) },
    grandTotal: { y: excelRowToY(40), x: excelColToX('M') }, // Grand total in column M
  },
};

/**
 * Wrap text to fit within a maximum width
 */
function wrapTextToWidth(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const width = font.widthOfTextAtSize(testLine, fontSize);
    
    if (width <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = word;
    }
  }
  
  if (currentLine) {
    lines.push(currentLine);
  }
  
  return lines;
}

/**
 * Truncate text if it exceeds max lines
 */
function truncateLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  return lines.slice(0, maxLines);
}

/**
 * Draw wrapped and truncated text
 */
function drawWrappedText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  fontSize: number,
  x: number,
  y: number,
  maxWidth: number,
  maxLines: number
): number {
  const lines = wrapTextToWidth(text, font, fontSize, maxWidth);
  const truncated = truncateLines(lines, maxLines);
  
  let currentY = y;
  for (const line of truncated) {
    page.drawText(line, {
      x,
      y: currentY,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
    currentY -= fontSize + 2; // Line spacing
  }
  
  return truncated.length;
}

/**
 * Generate PDF service ticket from template
 */
export async function generatePdfServiceTicket(ticket: ServiceTicket): Promise<Uint8Array> {
  try {
    // Fetch the blank template
    const templateResponse = await fetch('/templates/Service-Ticket-Example.pdf');
    if (!templateResponse.ok) {
      throw new Error('Failed to fetch PDF template');
    }
    const templateBytes = await templateResponse.arrayBuffer();
    
    // Load the template
    const pdfDoc = await PDFDocument.load(templateBytes);
    const pages = pdfDoc.getPages();
    
    if (pages.length === 0) {
      throw new Error('Template PDF has no pages');
    }
    
    const templatePage = pages[0];
    const font = await pdfDoc.embedFont('Helvetica');
    const boldFont = await pdfDoc.embedFont('Helvetica-Bold');
    
    // Helper to add a page based on template
    const addPage = async (): Promise<PDFPage> => {
      const [copiedPage] = await pdfDoc.copyPages(pdfDoc, [0]);
      return pdfDoc.addPage(copiedPage);
    };
    
    // Use the first page for the main content
    let currentPage = templatePage;
    let currentRowIndex = 0;
    
    // Generate ticket ID
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    
    // Fill in header information
    currentPage.drawText(ticketId, {
      x: LAYOUT.ticketNumber.x,
      y: LAYOUT.ticketNumber.y,
      size: 10,
      font: boldFont,
    });
    
    // Customer information
    currentPage.drawText(ticket.customerInfo.name, {
      x: LAYOUT.customerName.x,
      y: LAYOUT.customerName.y,
      size: 9,
      font,
    });
    
    if (ticket.customerInfo.address) {
      currentPage.drawText(ticket.customerInfo.address, {
        x: LAYOUT.billingAddress.x,
        y: LAYOUT.billingAddress.y,
        size: 8,
        font,
      });
    }
    
    currentPage.drawText(ticket.userName, {
      x: LAYOUT.contactName.x,
      y: LAYOUT.contactName.y,
      size: 8,
      font,
    });
    
    if (ticket.customerInfo.phone) {
      currentPage.drawText(ticket.customerInfo.phone, {
        x: LAYOUT.contactPhone.x,
        y: LAYOUT.contactPhone.y,
        size: 8,
        font,
      });
    }
    
    if (ticket.customerInfo.email) {
      currentPage.drawText(ticket.customerInfo.email, {
        x: LAYOUT.contactEmail.x,
        y: LAYOUT.contactEmail.y,
        size: 8,
        font,
      });
    }
    
    if (ticket.customerInfo.address) {
      currentPage.drawText(ticket.customerInfo.address, {
        x: LAYOUT.serviceLocation.x,
        y: LAYOUT.serviceLocation.y,
        size: 8,
        font,
      });
    }
    
    if (ticket.customerInfo.tax_id) {
      currentPage.drawText(ticket.customerInfo.tax_id, {
        x: LAYOUT.poAfeCc.x,
        y: LAYOUT.poAfeCc.y,
        size: 8,
        font,
      });
    }
    
    // Service information
    const jobId = ticket.entries[0]?.id.substring(0, 8) || 'N/A';
    currentPage.drawText(jobId, {
      x: LAYOUT.jobId.x,
      y: LAYOUT.jobId.y,
      size: 8,
      font,
    });
    
    currentPage.drawText('Auto', {
      x: LAYOUT.jobType.x,
      y: LAYOUT.jobType.y,
      size: 8,
      font,
    });
    
    currentPage.drawText(ticket.userName, {
      x: LAYOUT.tech.x,
      y: LAYOUT.tech.y,
      size: 8,
      font,
    });
    
    const formattedDate = new Date(ticket.date).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    });
    currentPage.drawText(formattedDate, {
      x: LAYOUT.date.x,
      y: LAYOUT.date.y,
      size: 8,
      font,
    });
    
    // Draw time entries (with pagination support)
    let currentY = LAYOUT.descriptionBox.startY;
    
    for (const entry of ticket.entries) {
      // Check if we need a new page
      if (currentRowIndex >= LAYOUT.descriptionBox.maxRows) {
        currentPage = await addPage();
        currentRowIndex = 0;
        currentY = LAYOUT.descriptionBox.startY;
      }
      
      // Description (wrap to 3 lines max per entry)
      const description = entry.description || 'No description';
      const descWidth = LAYOUT.columns.rt - LAYOUT.columns.description - 10;
      drawWrappedText(
        currentPage,
        description,
        font,
        8,
        LAYOUT.columns.description,
        currentY,
        descWidth,
        1 // Single line, truncate if longer
      );
      
      // Hours in appropriate column
      const hours = entry.hours.toFixed(2);
      const rateType = entry.rate_type || 'Shop Time';
      
      let columnX = LAYOUT.columns.rt;
      if (rateType === 'Travel Time') {
        columnX = LAYOUT.columns.tt;
      } else if (rateType === 'Field Time') {
        columnX = LAYOUT.columns.ft;
      } else if (rateType === 'Shop Overtime' || rateType === 'Field Overtime') {
        columnX = LAYOUT.columns.ot;
      }
      
      currentPage.drawText(hours, {
        x: columnX,
        y: currentY,
        size: 8,
        font,
      });
      
      currentY -= LAYOUT.descriptionBox.rowHeight;
      currentRowIndex++;
    }
    
    // Draw totals on the first page only
    const firstPage = pages[0];
    firstPage.drawText(ticket.hoursByRateType['Shop Time'].toFixed(2), {
      x: LAYOUT.totals.rt,
      y: LAYOUT.totals.y,
      size: 9,
      font: boldFont,
    });
    
    firstPage.drawText(ticket.hoursByRateType['Travel Time'].toFixed(2), {
      x: LAYOUT.totals.tt,
      y: LAYOUT.totals.y,
      size: 9,
      font: boldFont,
    });
    
    firstPage.drawText(ticket.hoursByRateType['Field Time'].toFixed(2), {
      x: LAYOUT.totals.ft,
      y: LAYOUT.totals.y,
      size: 9,
      font: boldFont,
    });
    
    const totalOT = ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime'];
    firstPage.drawText(totalOT.toFixed(2), {
      x: LAYOUT.totals.ot,
      y: LAYOUT.totals.y,
      size: 9,
      font: boldFont,
    });
    
    // Summary calculations
    const rtRate = 130.00;
    const ttRate = 140.00;
    const ftRate = 140.00;
    const otRate = 195.00;
    
    const rtTotal = ticket.hoursByRateType['Shop Time'] * rtRate;
    const ttTotal = ticket.hoursByRateType['Travel Time'] * ttRate;
    const ftTotal = ticket.hoursByRateType['Field Time'] * ftRate;
    const otTotal = totalOT * otRate;
    const grandTotal = rtTotal + ttTotal + ftTotal + otTotal;
    
    firstPage.drawText(`$${rtTotal.toFixed(2)}`, {
      x: LAYOUT.summary.x,
      y: LAYOUT.summary.totalRT.y,
      size: 9,
      font,
    });
    
    firstPage.drawText(`$${ttTotal.toFixed(2)}`, {
      x: LAYOUT.summary.x,
      y: LAYOUT.summary.totalTT.y,
      size: 9,
      font,
    });
    
    firstPage.drawText(`$${ftTotal.toFixed(2)}`, {
      x: LAYOUT.summary.x,
      y: LAYOUT.summary.totalFT.y,
      size: 9,
      font,
    });
    
    firstPage.drawText(`$${otTotal.toFixed(2)}`, {
      x: LAYOUT.summary.x,
      y: LAYOUT.summary.totalOT.y,
      size: 9,
      font,
    });
    
    firstPage.drawText('$0.00', {
      x: LAYOUT.summary.x,
      y: LAYOUT.summary.totalExpenses.y,
      size: 9,
      font,
    });
    
    firstPage.drawText(`$${grandTotal.toFixed(2)}`, {
      x: LAYOUT.summary.grandTotal.x,
      y: LAYOUT.summary.grandTotal.y,
      size: 11,
      font: boldFont,
    });
    
    // Save the PDF
    const pdfBytes = await pdfDoc.save();
    return pdfBytes;
    
  } catch (error) {
    console.error('Error generating PDF:', error);
    throw error;
  }
}

/**
 * Download the generated PDF
 */
export async function downloadPdfServiceTicket(ticket: ServiceTicket): Promise<void> {
  const pdfBytes = await generatePdfServiceTicket(ticket);
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  
  const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
  const fileName = `ServiceTicket_${ticketId}_${ticket.customerName.replace(/\s+/g, '_')}.pdf`;
  
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  
  URL.revokeObjectURL(url);
}

