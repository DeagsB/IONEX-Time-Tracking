import { PDFDocument, PDFPage, PDFFont, rgb } from 'pdf-lib';
import { ServiceTicket } from './serviceTickets';
import { parseExcelTemplateMapping, excelCellToPdfCoords, getRowFromAddress, createCellAddress } from './excelTemplateMapping';

// PDF page dimensions
const PAGE_HEIGHT = 792;

/**
 * Maps ticket data fields to placeholder strings (same as Excel export)
 */
function getFieldValueForPlaceholder(placeholder: string, ticket: ServiceTicket): string {
  const customer = ticket.customerInfo;
  
  const mappings: { [key: string]: string } = {
    '(Customer Here)': customer.name || '',
    '(Street address)': customer.address || '',
    '(City, Province)': customer.city && customer.state 
      ? `${customer.city}, ${customer.state}` 
      : customer.city || customer.state || '',
    '(Postal Code)': customer.zip_code || '',
    '(Name)': ticket.userName || '',
    '(Phone number)': customer.phone || '',
    '(Email)': customer.email || '',
    '(Location)': customer.service_location || customer.address || '',
    '(Location Code)': customer.location_code || '',
    '(PO)': customer.po_number || '',
    '(Approver)': customer.approver_name || '',
    '(Job ID)': ticket.entries[0]?.id.substring(0, 8) || 'AUTO',
    '(Employee Name)': ticket.userName || '',
    '(Date from time entry)': new Date(ticket.date).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    }),
  };
  
  return mappings[placeholder] || '';
}

/**
 * Wrap text to fit within a maximum width (word wrap)
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
 * Generate PDF service ticket using Excel template mapping
 */
export async function generatePdfServiceTicket(ticket: ServiceTicket): Promise<Uint8Array> {
  try {
    // Fetch the blank PDF template
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
    
    const firstPage = pages[0];
    const font = await pdfDoc.embedFont('Helvetica');
    const boldFont = await pdfDoc.embedFont('Helvetica-Bold');
    
    // Get the Excel mapping
    const mapping = await parseExcelTemplateMapping();
    
    // Generate ticket ID
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    
    // Fill ticket number at M1
    const ticketNumCoords = excelCellToPdfCoords('M1', PAGE_HEIGHT);
    firstPage.drawText(ticketId, {
      x: ticketNumCoords.x,
      y: ticketNumCoords.y,
      size: 10,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // Fill in all mapped header fields
    for (const [placeholder, cellAddresses] of Object.entries(mapping)) {
      const value = getFieldValueForPlaceholder(placeholder, ticket);
      
      // Skip if no value
      if (!value) continue;
      
      // Draw text at each cell location (usually just one per field)
      for (const cellAddress of cellAddresses) {
        const coords = excelCellToPdfCoords(cellAddress, PAGE_HEIGHT);
        
        // Determine font size based on row (header fields are smaller)
        const row = getRowFromAddress(cellAddress);
        const fontSize = row <= 11 ? 9 : 8;
        
        firstPage.drawText(value, {
          x: coords.x,
          y: coords.y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }
    
    // Fill in line items (starting at row 14)
    const firstDataRow = 14;
    const lastDataRow = 23; // 10 rows max per page
    const descriptionCol = 'B';
    const maxDescWidth = 350; // Maximum width for description text
    
    let currentRow = firstDataRow;
    let currentPage = firstPage;
    
    for (const entry of ticket.entries) {
      // Check if we need a new page
      if (currentRow > lastDataRow) {
        // Create a new page by copying the template
        const [copiedPage] = await pdfDoc.copyPages(pdfDoc, [0]);
        currentPage = pdfDoc.addPage(copiedPage);
        currentRow = firstDataRow;
      }
      
      // Description
      const descAddr = createCellAddress(currentRow, descriptionCol);
      const descCoords = excelCellToPdfCoords(descAddr, PAGE_HEIGHT);
      
      const description = entry.description || 'No description';
      const wrappedLines = wrapTextToWidth(description, font, 8, maxDescWidth);
      
      // Draw first line only (truncate if too long)
      if (wrappedLines.length > 0) {
        currentPage.drawText(wrappedLines[0], {
          x: descCoords.x,
          y: descCoords.y,
          size: 8,
          font,
          color: rgb(0, 0, 0),
        });
      }
      
      // Hours in the appropriate column
      const rateType = entry.rate_type || 'Shop Time';
      let hoursCol = 'K'; // RT
      
      if (rateType === 'Travel Time') {
        hoursCol = 'L'; // TT
      } else if (rateType === 'Field Time') {
        hoursCol = 'M'; // FT
      } else if (rateType === 'Shop Overtime' || rateType === 'Field Overtime') {
        hoursCol = 'N'; // OT
      }
      
      const hoursAddr = createCellAddress(currentRow, hoursCol);
      const hoursCoords = excelCellToPdfCoords(hoursAddr, PAGE_HEIGHT);
      
      currentPage.drawText(entry.hours.toFixed(2), {
        x: hoursCoords.x,
        y: hoursCoords.y,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      });
      
      currentRow++;
    }
    
    // Draw totals on the first page (row 24)
    const totalsRow = 24;
    
    // RT total
    const rtTotalAddr = createCellAddress(totalsRow, 'K');
    const rtTotalCoords = excelCellToPdfCoords(rtTotalAddr, PAGE_HEIGHT);
    firstPage.drawText(ticket.hoursByRateType['Shop Time'].toFixed(2), {
      x: rtTotalCoords.x,
      y: rtTotalCoords.y,
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // TT total
    const ttTotalAddr = createCellAddress(totalsRow, 'L');
    const ttTotalCoords = excelCellToPdfCoords(ttTotalAddr, PAGE_HEIGHT);
    firstPage.drawText(ticket.hoursByRateType['Travel Time'].toFixed(2), {
      x: ttTotalCoords.x,
      y: ttTotalCoords.y,
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // FT total
    const ftTotalAddr = createCellAddress(totalsRow, 'M');
    const ftTotalCoords = excelCellToPdfCoords(ftTotalAddr, PAGE_HEIGHT);
    firstPage.drawText(ticket.hoursByRateType['Field Time'].toFixed(2), {
      x: ftTotalCoords.x,
      y: ftTotalCoords.y,
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // OT total (combined Shop OT + Field OT)
    const totalOT = ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime'];
    const otTotalAddr = createCellAddress(totalsRow, 'N');
    const otTotalCoords = excelCellToPdfCoords(otTotalAddr, PAGE_HEIGHT);
    firstPage.drawText(totalOT.toFixed(2), {
      x: otTotalCoords.x,
      y: otTotalCoords.y,
      size: 9,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // Summary calculations (rows 35-40, column M)
    const rtRate = 130.00;
    const ttRate = 140.00;
    const ftRate = 140.00;
    const otRate = 195.00;
    
    const rtTotal = ticket.hoursByRateType['Shop Time'] * rtRate;
    const ttTotal = ticket.hoursByRateType['Travel Time'] * ttRate;
    const ftTotal = ticket.hoursByRateType['Field Time'] * ftRate;
    const otTotal = totalOT * otRate;
    const grandTotal = rtTotal + ttTotal + ftTotal + otTotal;
    
    // Total RT (M35)
    const summaryRtCoords = excelCellToPdfCoords('M35', PAGE_HEIGHT);
    firstPage.drawText(`$${rtTotal.toFixed(2)}`, {
      x: summaryRtCoords.x,
      y: summaryRtCoords.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Total TT (M36)
    const summaryTtCoords = excelCellToPdfCoords('M36', PAGE_HEIGHT);
    firstPage.drawText(`$${ttTotal.toFixed(2)}`, {
      x: summaryTtCoords.x,
      y: summaryTtCoords.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Total FT (M37)
    const summaryFtCoords = excelCellToPdfCoords('M37', PAGE_HEIGHT);
    firstPage.drawText(`$${ftTotal.toFixed(2)}`, {
      x: summaryFtCoords.x,
      y: summaryFtCoords.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Total OT (M38)
    const summaryOtCoords = excelCellToPdfCoords('M38', PAGE_HEIGHT);
    firstPage.drawText(`$${otTotal.toFixed(2)}`, {
      x: summaryOtCoords.x,
      y: summaryOtCoords.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Total Expenses (M39) - currently $0.00
    const summaryExpensesCoords = excelCellToPdfCoords('M39', PAGE_HEIGHT);
    firstPage.drawText('$0.00', {
      x: summaryExpensesCoords.x,
      y: summaryExpensesCoords.y,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Grand Total (M40)
    const grandTotalCoords = excelCellToPdfCoords('M40', PAGE_HEIGHT);
    firstPage.drawText(`$${grandTotal.toFixed(2)}`, {
      x: grandTotalCoords.x,
      y: grandTotalCoords.y,
      size: 11,
      font: boldFont,
      color: rgb(0, 0, 0),
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
