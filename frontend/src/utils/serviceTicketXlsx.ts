import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { ServiceTicket } from './serviceTickets';

/**
 * Generates a clean Excel service ticket from scratch (no template needed)
 * This approach guarantees no corruption issues
 */
export async function generateExcelServiceTicket(ticket: ServiceTicket): Promise<Uint8Array> {
  try {
    // Create a new workbook from scratch
    const workbook = new ExcelJS.Workbook();
    
    // Set workbook properties
    workbook.creator = 'IONEX Time Tracking';
    workbook.created = new Date();
    
    // Create the worksheet
    const worksheet = workbook.addWorksheet('Service Ticket', {
      pageSetup: {
        paperSize: 9, // Letter size
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    
    // Set column widths
    worksheet.columns = [
      { width: 3 },   // A - margin
      { width: 40 },  // B - Description
      { width: 15 },  // C
      { width: 15 },  // D
      { width: 15 },  // E
      { width: 10 },  // F
      { width: 10 },  // G
      { width: 15 },  // H
      { width: 15 },  // I
      { width: 8 },   // J
      { width: 10 },  // K - RT
      { width: 10 },  // L - TT
      { width: 10 },  // M - FT
      { width: 10 },  // N - OT
    ];
    
    // Generate ticket ID
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    
    // === HEADER SECTION ===
    // Title
    worksheet.mergeCells('B1:I1');
    const titleCell = worksheet.getCell('B1');
    titleCell.value = 'SERVICE TICKET';
    titleCell.font = { size: 20, bold: true, color: { argb: 'FF2E5090' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getRow(1).height = 30;
    
    // Ticket Number
    worksheet.mergeCells('K1:N1');
    const ticketCell = worksheet.getCell('K1');
    ticketCell.value = `Ticket: ${ticketId}`;
    ticketCell.font = { size: 11, bold: true };
    ticketCell.alignment = { horizontal: 'right', vertical: 'middle' };
    
    // Add spacing
    worksheet.getRow(2).height = 5;
    
    // === CUSTOMER & SERVICE INFO SECTION ===
    let currentRow = 3;
    
    // Customer Information Header
    worksheet.mergeCells(`B${currentRow}:F${currentRow}`);
    const custHeaderCell = worksheet.getCell(`B${currentRow}`);
    custHeaderCell.value = 'CUSTOMER INFORMATION';
    custHeaderCell.font = { size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    custHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    custHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
    custHeaderCell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' }
    };
    
    // Service Information Header
    worksheet.mergeCells(`H${currentRow}:N${currentRow}`);
    const svcHeaderCell = worksheet.getCell(`H${currentRow}`);
    svcHeaderCell.value = 'SERVICE INFORMATION';
    svcHeaderCell.font = { size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    svcHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    svcHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
    svcHeaderCell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' }
    };
    worksheet.getRow(currentRow).height = 20;
    currentRow++;
    
    // Customer details
    const customer = ticket.customerInfo;
    const addInfoRow = (label: string, value: string, col1: string, col2: string) => {
      worksheet.getCell(`${col1}${currentRow}`).value = label;
      worksheet.getCell(`${col1}${currentRow}`).font = { bold: true, size: 10 };
      worksheet.getCell(`${col1}${currentRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
      
      worksheet.mergeCells(`${col2}${currentRow}:F${currentRow}`);
      worksheet.getCell(`${col2}${currentRow}`).value = value;
      worksheet.getCell(`${col2}${currentRow}`).font = { size: 10 };
      
      // Add borders
      ['B', 'C', 'D', 'E', 'F'].forEach(col => {
        worksheet.getCell(`${col}${currentRow}`).border = {
          top: { style: 'thin' }, bottom: { style: 'thin' },
          left: { style: 'thin' }, right: { style: 'thin' }
        };
      });
      
      worksheet.getRow(currentRow).height = 18;
      currentRow++;
    };
    
    const addServiceRow = (label: string, value: string, col1: string, col2: string) => {
      worksheet.getCell(`${col1}${currentRow - 1}`).value = label;
      worksheet.getCell(`${col1}${currentRow - 1}`).font = { bold: true, size: 10 };
      worksheet.getCell(`${col1}${currentRow - 1}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
      
      worksheet.mergeCells(`${col2}${currentRow - 1}:N${currentRow - 1}`);
      worksheet.getCell(`${col2}${currentRow - 1}`).value = value;
      worksheet.getCell(`${col2}${currentRow - 1}`).font = { size: 10 };
      
      // Add borders
      ['H', 'I', 'J', 'K', 'L', 'M', 'N'].forEach(col => {
        worksheet.getCell(`${col}${currentRow - 1}`).border = {
          top: { style: 'thin' }, bottom: { style: 'thin' },
          left: { style: 'thin' }, right: { style: 'thin' }
        };
      });
    };
    
    // Add customer info rows
    addInfoRow('Customer:', customer.name || '', 'B', 'C');
    addServiceRow('Tech:', ticket.userName, 'H', 'I');
    
    addInfoRow('Address:', customer.address || '', 'B', 'C');
    addServiceRow('Date:', new Date(ticket.date).toLocaleDateString('en-US', {
      month: '2-digit', day: '2-digit', year: 'numeric'
    }), 'H', 'I');
    
    addInfoRow('City/State:', customer.city && customer.state 
      ? `${customer.city}, ${customer.state}` 
      : customer.city || customer.state || '', 'B', 'C');
    addServiceRow('Job ID:', ticket.entries[0]?.id.substring(0, 8) || 'AUTO', 'H', 'I');
    
    addInfoRow('Phone:', customer.phone || '', 'B', 'C');
    addServiceRow('Location Code:', customer.location_code || '', 'H', 'I');
    
    addInfoRow('Email:', customer.email || '', 'B', 'C');
    addServiceRow('PO Number:', customer.po_number || '', 'H', 'I');
    
    currentRow++;
    
    // === TIME ENTRIES SECTION ===
    // Header row
    worksheet.mergeCells(`B${currentRow}:J${currentRow}`);
    const descHeaderCell = worksheet.getCell(`B${currentRow}`);
    descHeaderCell.value = 'SERVICE DESCRIPTION';
    descHeaderCell.font = { size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    descHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } };
    descHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
    descHeaderCell.border = {
      top: { style: 'medium' }, bottom: { style: 'thin' },
      left: { style: 'medium' }, right: { style: 'thin' }
    };
    
    // Time column headers
    ['K', 'L', 'M', 'N'].forEach((col, idx) => {
      const labels = ['RT', 'TT', 'FT', 'OT'];
      const cell = worksheet.getCell(`${col}${currentRow}`);
      cell.value = labels[idx];
      cell.font = { size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'medium' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: col === 'N' ? { style: 'medium' } : { style: 'thin' }
      };
    });
    worksheet.getRow(currentRow).height = 20;
    currentRow++;
    
    const firstDataRow = currentRow;
    
    // Add time entries
    for (const entry of ticket.entries) {
      // Description
      worksheet.mergeCells(`B${currentRow}:J${currentRow}`);
      const descCell = worksheet.getCell(`B${currentRow}`);
      descCell.value = entry.description || 'No description';
      descCell.font = { size: 10 };
      descCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      descCell.border = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'medium' }, right: { style: 'thin' }
      };
      
      // Hours in appropriate column
      const rateType = entry.rate_type || 'Shop Time';
      let hoursCol = 'K'; // RT
      if (rateType === 'Travel Time') hoursCol = 'L';
      else if (rateType === 'Field Time') hoursCol = 'M';
      else if (rateType.includes('Overtime')) hoursCol = 'N';
      
      // Add hours
      const hoursCell = worksheet.getCell(`${hoursCol}${currentRow}`);
      hoursCell.value = entry.hours;
      hoursCell.numFmt = '0.00';
      hoursCell.font = { size: 10 };
      hoursCell.alignment = { horizontal: 'center', vertical: 'middle' };
      hoursCell.border = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: hoursCol === 'N' ? { style: 'medium' } : { style: 'thin' }
      };
      
      // Empty cells for other columns
      ['K', 'L', 'M', 'N'].forEach(col => {
        if (col !== hoursCol) {
          const cell = worksheet.getCell(`${col}${currentRow}`);
          cell.border = {
            top: { style: 'thin' }, bottom: { style: 'thin' },
            left: { style: 'thin' }, right: col === 'N' ? { style: 'medium' } : { style: 'thin' }
          };
        }
      });
      
      worksheet.getRow(currentRow).height = 30;
      currentRow++;
      
      if (currentRow - firstDataRow >= 15) break; // Limit to 15 entries
    }
    
    const lastDataRow = currentRow - 1;
    
    // === TOTALS ROW ===
    worksheet.mergeCells(`B${currentRow}:J${currentRow}`);
    const totalsLabelCell = worksheet.getCell(`B${currentRow}`);
    totalsLabelCell.value = 'TOTAL TIME';
    totalsLabelCell.font = { size: 11, bold: true };
    totalsLabelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD966' } };
    totalsLabelCell.alignment = { horizontal: 'right', vertical: 'middle' };
    totalsLabelCell.border = {
      top: { style: 'medium' }, bottom: { style: 'medium' },
      left: { style: 'medium' }, right: { style: 'thin' }
    };
    
    // Add total formulas
    ['K', 'L', 'M', 'N'].forEach(col => {
      const cell = worksheet.getCell(`${col}${currentRow}`);
      cell.value = { formula: `SUM(${col}${firstDataRow}:${col}${lastDataRow})`, result: 0 };
      cell.numFmt = '0.00';
      cell.font = { size: 11, bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD966' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'medium' }, bottom: { style: 'medium' },
        left: { style: 'thin' }, right: col === 'N' ? { style: 'medium' } : { style: 'thin' }
      };
    });
    worksheet.getRow(currentRow).height = 20;
    currentRow += 2;
    
    // === SUMMARY SECTION ===
    const summaryRow = currentRow;
    worksheet.mergeCells(`H${currentRow}:K${currentRow}`);
    const summaryHeaderCell = worksheet.getCell(`H${currentRow}`);
    summaryHeaderCell.value = 'SERVICE TICKET SUMMARY';
    summaryHeaderCell.font = { size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    summaryHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    summaryHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
    summaryHeaderCell.border = {
      top: { style: 'medium' }, bottom: { style: 'thin' },
      left: { style: 'medium' }, right: { style: 'medium' }
    };
    worksheet.getRow(currentRow).height = 20;
    currentRow++;
    
    // Summary line items
    const rtRate = 130;
    const ttRate = 140;
    const ftRate = 140;
    const otRate = 195;
    
    const addSummaryLine = (label: string, rate: number, hoursCol: string) => {
      worksheet.getCell(`H${currentRow}`).value = label;
      worksheet.getCell(`H${currentRow}`).font = { size: 10, bold: true };
      worksheet.getCell(`H${currentRow}`).alignment = { horizontal: 'left', vertical: 'middle' };
      worksheet.getCell(`H${currentRow}`).border = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'medium' }, right: { style: 'thin' }
      };
      
      worksheet.getCell(`K${currentRow}`).value = { 
        formula: `${hoursCol}${lastDataRow + 1}*${rate}`, 
        result: 0 
      };
      worksheet.getCell(`K${currentRow}`).numFmt = '$#,##0.00';
      worksheet.getCell(`K${currentRow}`).font = { size: 10 };
      worksheet.getCell(`K${currentRow}`).alignment = { horizontal: 'right', vertical: 'middle' };
      worksheet.getCell(`K${currentRow}`).border = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'medium' }
      };
      
      worksheet.getRow(currentRow).height = 18;
      currentRow++;
    };
    
    addSummaryLine('Total RT (@$130/hr):', rtRate, 'K');
    addSummaryLine('Total TT (@$140/hr):', ttRate, 'L');
    addSummaryLine('Total FT (@$140/hr):', ftRate, 'M');
    addSummaryLine('Total OT (@$195/hr):', otRate, 'N');
    
    // Grand total
    worksheet.getCell(`H${currentRow}`).value = 'TOTAL SERVICE TICKET';
    worksheet.getCell(`H${currentRow}`).font = { size: 11, bold: true };
    worksheet.getCell(`H${currentRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD966' } };
    worksheet.getCell(`H${currentRow}`).alignment = { horizontal: 'left', vertical: 'middle' };
    worksheet.getCell(`H${currentRow}`).border = {
      top: { style: 'medium' }, bottom: { style: 'medium' },
      left: { style: 'medium' }, right: { style: 'thin' }
    };
    
    const firstSummaryRow = summaryRow + 1;
    worksheet.getCell(`K${currentRow}`).value = { 
      formula: `SUM(K${firstSummaryRow}:K${currentRow - 1})`, 
      result: 0 
    };
    worksheet.getCell(`K${currentRow}`).numFmt = '$#,##0.00';
    worksheet.getCell(`K${currentRow}`).font = { size: 11, bold: true };
    worksheet.getCell(`K${currentRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD966' } };
    worksheet.getCell(`K${currentRow}`).alignment = { horizontal: 'right', vertical: 'middle' };
    worksheet.getCell(`K${currentRow}`).border = {
      top: { style: 'medium' }, bottom: { style: 'medium' },
      left: { style: 'thin' }, right: { style: 'medium' }
    };
    worksheet.getRow(currentRow).height = 22;
    
    // Generate the file
    const buffer = await workbook.xlsx.writeBuffer({
      useStyles: true,
      useSharedStrings: true,
    });
    
    return new Uint8Array(buffer);
    
  } catch (error) {
    console.error('Error generating Excel service ticket:', error);
    throw error;
  }
}

/**
 * Downloads the generated Excel file
 */
export async function downloadExcelServiceTicket(ticket: ServiceTicket): Promise<void> {
  try {
    const excelBytes = await generateExcelServiceTicket(ticket);
    const blob = new Blob([excelBytes as any], { 
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
    });
    
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    const fileName = `ServiceTicket_${ticketId}_${ticket.customerName.replace(/\s+/g, '_')}.xlsx`;
    
    saveAs(blob, fileName);
  } catch (error) {
    console.error('Error downloading Excel service ticket:', error);
    throw error;
  }
}
