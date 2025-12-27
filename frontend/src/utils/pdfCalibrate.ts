import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/**
 * Creates a calibration PDF with grid lines and coordinate markers
 * to help identify exact positions for text placement
 */
export async function generateCalibrationPdf(): Promise<Uint8Array> {
  // Load the template
  const templateResponse = await fetch('/templates/Service-Ticket-Example.pdf');
  if (!templateResponse.ok) {
    throw new Error('Failed to fetch PDF template');
  }
  const templateBytes = await templateResponse.arrayBuffer();
  const pdfDoc = await PDFDocument.load(templateBytes);
  
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.getPages()[0];
  
  // Draw horizontal grid lines every 50 points with Y coordinate labels
  for (let y = 0; y <= 800; y += 50) {
    page.drawLine({
      start: { x: 0, y },
      end: { x: 612, y },
      thickness: 0.5,
      color: rgb(1, 0, 0),
      opacity: 0.3,
    });
    page.drawText(`Y=${y}`, {
      x: 5,
      y: y + 2,
      size: 6,
      font,
      color: rgb(1, 0, 0),
    });
  }
  
  // Draw vertical grid lines every 50 points with X coordinate labels
  for (let x = 0; x <= 612; x += 50) {
    page.drawLine({
      start: { x, y: 0 },
      end: { x, y: 792 },
      thickness: 0.5,
      color: rgb(0, 0, 1),
      opacity: 0.3,
    });
    page.drawText(`X=${x}`, {
      x: x + 2,
      y: 5,
      size: 6,
      font,
      color: rgb(0, 0, 1),
    });
  }
  
  // Mark the current layout positions with green dots and labels
  const positions: { [key: string]: { x: number; y: number } } = {
    'Ticket#': { x: 545, y: 755 },
    'CustName': { x: 478, y: 688 },
    'BillAddr': { x: 478, y: 672 },
    'Contact': { x: 478, y: 640 },
    'Phone': { x: 478, y: 624 },
    'Email': { x: 478, y: 608 },
    'Location': { x: 478, y: 592 },
    'PO': { x: 478, y: 576 },
    'JobID': { x: 108, y: 622 },
    'JobType': { x: 235, y: 622 },
    'Tech': { x: 108, y: 604 },
    'Date': { x: 108, y: 586 },
    'Desc': { x: 75, y: 532 },
    'RT': { x: 430, y: 532 },
    'TT': { x: 462, y: 532 },
    'FT': { x: 494, y: 532 },
    'OT': { x: 526, y: 532 },
    'Totals': { x: 430, y: 395 },
    'RTRate': { x: 145, y: 375 },
    'FTRate': { x: 290, y: 375 },
    'SumRT': { x: 558, y: 248 },
    'SumTT': { x: 558, y: 233 },
    'SumFT': { x: 558, y: 218 },
    'SumOT': { x: 558, y: 203 },
    'SumExp': { x: 558, y: 188 },
    'Total$': { x: 558, y: 168 },
    'AFE': { x: 105, y: 218 },
    'CC': { x: 105, y: 198 },
  };
  
  for (const [label, pos] of Object.entries(positions)) {
    // Draw a small green circle at the position
    page.drawCircle({
      x: pos.x,
      y: pos.y,
      size: 3,
      color: rgb(0, 0.8, 0),
    });
    
    // Draw the label
    page.drawText(`${label}(${pos.x},${pos.y})`, {
      x: pos.x + 5,
      y: pos.y - 2,
      size: 5,
      font,
      color: rgb(0, 0.6, 0),
    });
  }
  
  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}

/**
 * Download the calibration PDF
 */
export async function downloadCalibrationPdf(): Promise<void> {
  const pdfBytes = await generateCalibrationPdf();
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ServiceTicket_CALIBRATION.pdf';
  link.click();
  
  URL.revokeObjectURL(url);
}

