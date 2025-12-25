import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { ServiceTicket } from './serviceTickets';

/**
 * Fetches the service ticket template from the public folder
 */
async function fetchTemplate(): Promise<ArrayBuffer> {
  const response = await fetch('/templates/service-ticket-template.xlsx');
  if (!response.ok) {
    throw new Error('Failed to fetch template');
  }
  return await response.arrayBuffer();
}

/**
 * Populates the Excel template with service ticket data
 */
export async function exportServiceTicketToExcel(ticket: ServiceTicket): Promise<void> {
  try {
    // Fetch the template
    const templateBuffer = await fetchTemplate();
    
    // Read the workbook
    const workbook = XLSX.read(templateBuffer, { type: 'array' });
    
    // Get the first sheet
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Helper function to set cell value
    const setCellValue = (cell: string, value: any) => {
      worksheet[cell] = { v: value, t: typeof value === 'number' ? 'n' : 's' };
    };
    
    // Based on the actual template structure:
    
    // Ticket Number (top right)
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    setCellValue('M1', ticketId);
    
    // Customer Information (right side, rows 3-11)
    setCellValue('H3', ticket.customerInfo.name); // Customer Name
    setCellValue('H4', ticket.customerInfo.address || ''); // Billing Address
    
    // Contact info
    setCellValue('H7', ticket.userName); // Contact Name (using tech name)
    setCellValue('H8', ticket.customerInfo.phone || ''); // Contact Phone
    setCellValue('H9', ticket.customerInfo.email || ''); // Contact Email
    setCellValue('H10', ticket.customerInfo.address || ''); // Service Location
    setCellValue('H11', ticket.customerInfo.tax_id || ''); // PO/CC/AFE
    
    // Service Info (left side, rows 9-11)
    setCellValue('C9', ticket.entries[0]?.id.substring(0, 8) || 'N/A'); // Job ID
    setCellValue('E9', 'Auto'); // Job Type
    setCellValue('C10', ticket.userName); // Tech
    
    // Date (B11 label is "Date", C11 has the value)
    const dateValue = new Date(ticket.date);
    setCellValue('C11', dateValue); // Excel date format
    
    // Service Description section starts at row 14 (after row 13 headers)
    // Headers in row 13: K13=RT, L13=TT, M13=FT, N13=OT
    let descriptionRow = 14;
    ticket.entries.forEach((entry) => {
      const description = entry.description || 'No description';
      setCellValue(`B${descriptionRow}`, description); // Description in column B
      
      // Time columns based on rate_type
      const rateType = entry.rate_type || 'Shop Time';
      const hours = entry.hours || 0;
      
      // Map rate types to columns (K=RT, L=TT, M=FT, N=OT)
      if (rateType === 'Shop Time') {
        setCellValue(`K${descriptionRow}`, hours); // RT (column K)
      } else if (rateType === 'Travel Time') {
        setCellValue(`L${descriptionRow}`, hours); // TT (column L)
      } else if (rateType === 'Field Time') {
        setCellValue(`M${descriptionRow}`, hours); // FT (column M)
      } else if (rateType === 'Shop Overtime' || rateType === 'Field Overtime') {
        setCellValue(`N${descriptionRow}`, hours); // OT (column N)
      }
      
      descriptionRow++;
    });
    
    // Rates are in row 24: C24=130 (RT Rate), E24=140 (FT Rate)
    // These are already in template, no need to change unless rates vary
    
    // Total Time in row 24: K24, L24, M24, N24
    setCellValue('K24', ticket.hoursByRateType['Shop Time']); // Total RT
    setCellValue('L24', ticket.hoursByRateType['Travel Time']); // Total TT
    setCellValue('M24', ticket.hoursByRateType['Field Time']); // Total FT
    setCellValue('N24', ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime']); // Total OT
    
    // Service Ticket Summary (rows 35-40, column I for values)
    const rtRate = 130.00;
    const ftRate = 140.00;
    const ttRate = 140.00;
    const otRate = 195.00;
    
    const rtTotal = ticket.hoursByRateType['Shop Time'] * rtRate;
    const ttTotal = ticket.hoursByRateType['Travel Time'] * ttRate;
    const ftTotal = ticket.hoursByRateType['Field Time'] * ftRate;
    const otTotal = (ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime']) * otRate;
    
    setCellValue('I35', rtTotal.toFixed(2)); // Total RT $
    setCellValue('I36', ttTotal.toFixed(2)); // Total TT $
    setCellValue('I37', ftTotal.toFixed(2)); // Total FT $
    setCellValue('I38', otTotal.toFixed(2)); // Total OT $
    setCellValue('I39', '0.00'); // Total Expenses
    
    // TOTAL SERVICE TICKET (M40)
    const grandTotal = rtTotal + ttTotal + ftTotal + otTotal;
    setCellValue('M40', grandTotal.toFixed(2));
    
    // Generate the Excel file
    const outputBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    
    // Create blob and download
    const blob = new Blob([outputBuffer], { 
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
    });
    
    const fileName = `ServiceTicket_${ticketId}_${ticket.customerName.replace(/\s+/g, '_')}.xlsx`;
    saveAs(blob, fileName);
    
  } catch (error) {
    console.error('Error exporting service ticket:', error);
    throw error;
  }
}

/**
 * Debug function to examine template structure
 */
export async function examineTemplate(): Promise<void> {
  try {
    const templateBuffer = await fetchTemplate();
    const workbook = XLSX.read(templateBuffer, { type: 'array' });
    
    console.log('📊 Excel Template Analysis:');
    console.log('Sheet Names:', workbook.SheetNames);
    
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    console.log('Sheet Contents:', worksheet);
    
    // Get the range
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
    console.log('Range:', range);
    
    // Print first 30 rows to see structure
    console.log('\n📋 Template Structure:');
    for (let row = 0; row <= 30; row++) {
      const rowData: any = {};
      for (let col = 0; col <= 10; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = worksheet[cellAddress];
        if (cell) {
          rowData[cellAddress] = cell.v;
        }
      }
      if (Object.keys(rowData).length > 0) {
        console.log(`Row ${row + 1}:`, rowData);
      }
    }
  } catch (error) {
    console.error('Error examining template:', error);
  }
}

