import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { ServiceTicket } from './serviceTickets';
import { parseExcelTemplateMapping, createCellAddress, getRowFromAddress, getColumnFromAddress } from './excelTemplateMapping';

/**
 * Maps ticket data fields to placeholder strings in the Excel template
 */
function getFieldValueForPlaceholder(placeholder: string, ticket: ServiceTicket): string {
  const customer = ticket.customerInfo;
  
  // Map placeholders to actual data
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
    '(Billable Rate)': '130',
    '(Field Time Rate)': '140',
  };
  
  return mappings[placeholder] || '';
}

/**
 * Generates a filled Excel file from the template and ticket data
 */
export async function generateExcelServiceTicket(ticket: ServiceTicket): Promise<Uint8Array> {
  try {
    // Fetch the template
    const templateResponse = await fetch('/templates/service-ticket-template.xlsx');
    if (!templateResponse.ok) {
      throw new Error('Failed to fetch Excel template');
    }
    
    const templateBytes = await templateResponse.arrayBuffer();
    const workbook = XLSX.read(templateBytes, { 
      type: 'array',
      cellStyles: true,
      cellDates: true 
    });
    
    // Get the mapping from DB_25101 sheet
    const mapping = await parseExcelTemplateMapping();
    
    // Get the Template sheet (the one we'll fill and export)
    const templateSheetName = 'Template';
    if (!workbook.SheetNames.includes(templateSheetName)) {
      throw new Error(`Template sheet "${templateSheetName}" not found`);
    }
    
    const worksheet = workbook.Sheets[templateSheetName];
    
    // Fill in header fields using the mapping
    for (const [placeholder, cellAddresses] of Object.entries(mapping)) {
      const value = getFieldValueForPlaceholder(placeholder, ticket);
      
      // Skip if no value
      if (!value) continue;
      
      // Fill all cells that use this placeholder
      for (const cellAddress of cellAddresses) {
        // Write to the Template sheet at the same address
        if (!worksheet[cellAddress]) {
          worksheet[cellAddress] = {};
        }
        worksheet[cellAddress].v = value;
        worksheet[cellAddress].t = 's'; // string type
      }
    }
    
    // Fill in the ticket number (M1 in Template sheet)
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    if (worksheet['M1']) {
      worksheet['M1'].v = ticketId;
      worksheet['M1'].t = 's';
    }
    
    // Fill in line items (starting at row 14, based on DB_25101 structure)
    const firstDataRow = 14;
    const lastDataRow = 23; // 10 rows available
    const descriptionCol = 'B';
    const rtCol = 'K';
    const ttCol = 'L';
    const ftCol = 'M';
    const otCol = 'N';
    
    let currentRow = firstDataRow;
    for (const entry of ticket.entries) {
      if (currentRow > lastDataRow) {
        console.warn('Too many entries to fit in single sheet, truncating...');
        break;
      }
      
      // Description
      const descAddr = createCellAddress(currentRow, descriptionCol);
      if (!worksheet[descAddr]) worksheet[descAddr] = {};
      worksheet[descAddr].v = entry.description || 'No description';
      worksheet[descAddr].t = 's';
      
      // Hours in the appropriate column based on rate_type
      const rateType = entry.rate_type || 'Shop Time';
      let hoursCol = rtCol;
      
      if (rateType === 'Travel Time') {
        hoursCol = ttCol;
      } else if (rateType === 'Field Time') {
        hoursCol = ftCol;
      } else if (rateType === 'Shop Overtime' || rateType === 'Field Overtime') {
        hoursCol = otCol;
      }
      
      const hoursAddr = createCellAddress(currentRow, hoursCol);
      if (!worksheet[hoursAddr]) worksheet[hoursAddr] = {};
      worksheet[hoursAddr].v = entry.hours;
      worksheet[hoursAddr].t = 'n'; // number type
      
      currentRow++;
    }
    
    // The totals row (row 24) has formulas that will auto-calculate
    // Just make sure the formulas are preserved (they should be from the template)
    
    // Generate the output file
    const outputBytes = XLSX.write(workbook, { 
      type: 'array', 
      bookType: 'xlsx',
      cellStyles: true 
    });
    
    return new Uint8Array(outputBytes);
    
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

