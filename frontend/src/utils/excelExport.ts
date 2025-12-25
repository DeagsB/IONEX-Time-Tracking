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
    
    // Based on the screenshot, mapping data to cells:
    
    // Customer Information (Yellow section - top right)
    setCellValue('D3', ticket.customerInfo.name); // Customer Name
    setCellValue('D4', ticket.customerInfo.address || ''); // Billing Address
    setCellValue('D5', `${ticket.customerInfo.city || ''}, ${ticket.customerInfo.state || ''} ${ticket.customerInfo.zip_code || ''}`); // City, State, ZIP
    
    // Contact info
    const contactName = ticket.userName; // Using tech name as contact for now
    setCellValue('D7', contactName); // Contact Name
    setCellValue('D8', ticket.customerInfo.phone || ''); // Contact Phone
    setCellValue('D9', ticket.customerInfo.email || ''); // Contact Email
    
    // Service Location (Orange section)
    setCellValue('D10', ticket.customerInfo.address || ''); // Service Location
    setCellValue('D11', ticket.customerInfo.tax_id || ''); // PO/CC/AFE
    
    // Ticket info (top left)
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    setCellValue('D1', ticketId); // Ticket Number
    
    // Job info
    setCellValue('B3', ticket.entries[0]?.id.substring(0, 8) || 'N/A'); // Job ID
    setCellValue('B4', 'Auto'); // Job Type
    
    // Date
    const formattedDate = new Date(ticket.date).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    });
    setCellValue('B5', formattedDate); // Date Start
    setCellValue('B6', formattedDate); // Date End
    
    // Service Description (Green section - starting around row 12)
    let descriptionRow = 12;
    ticket.entries.forEach((entry) => {
      const description = entry.description || 'No description';
      setCellValue(`A${descriptionRow}`, description);
      
      // Time columns based on rate_type
      const rateType = entry.rate_type || 'Shop Time';
      const hours = entry.hours || 0;
      
      // Map rate types to columns (assuming columns D, E, F, G for RT, TT, FT, OT)
      if (rateType === 'Shop Time') {
        setCellValue(`D${descriptionRow}`, hours); // RT
      } else if (rateType === 'Travel Time') {
        setCellValue(`E${descriptionRow}`, hours); // TT
      } else if (rateType === 'Field Time') {
        setCellValue(`F${descriptionRow}`, hours); // FT
      } else if (rateType === 'Shop Overtime' || rateType === 'Field Overtime') {
        setCellValue(`G${descriptionRow}`, hours); // OT
      }
      
      descriptionRow++;
    });
    
    // Totals (Red section - bottom)
    const totalsRow = 26; // Approximate row for totals
    
    // RT Rate and Total
    setCellValue(`B${totalsRow}`, '$130.00'); // RT Rate
    setCellValue(`D${totalsRow}`, ticket.hoursByRateType['Shop Time'].toFixed(2)); // Total RT
    
    // FT Rate and Total  
    setCellValue(`B${totalsRow + 1}`, '$140.00'); // FT Rate
    setCellValue(`D${totalsRow + 1}`, ticket.hoursByRateType['Field Time'].toFixed(2)); // Total FT
    
    // Calculate totals
    const rtTotal = ticket.hoursByRateType['Shop Time'] * 130;
    const ftTotal = ticket.hoursByRateType['Field Time'] * 140;
    const ttTotal = ticket.hoursByRateType['Travel Time'] * 140;
    const otTotal = (ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime']) * 195;
    
    setCellValue(`E${totalsRow}`, rtTotal.toFixed(2)); // Total RT $
    setCellValue(`E${totalsRow + 1}`, ftTotal.toFixed(2)); // Total FT $
    
    // Total Time
    setCellValue(`D${totalsRow + 3}`, ticket.totalHours.toFixed(2));
    
    // Total Expenses
    setCellValue(`E${totalsRow + 4}`, '0.00');
    
    // TOTAL SERVICE TICKET
    const grandTotal = rtTotal + ftTotal + ttTotal + otTotal;
    setCellValue(`E${totalsRow + 5}`, grandTotal.toFixed(2));
    
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

