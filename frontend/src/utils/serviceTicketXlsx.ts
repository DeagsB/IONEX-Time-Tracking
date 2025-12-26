import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { ServiceTicket } from './serviceTickets';
import { parseExcelTemplateMapping, createCellAddress } from './excelTemplateMapping';

/**
 * Maps ticket data fields to placeholder strings in the Excel template
 */
function getFieldValueForPlaceholder(placeholder: string, ticket: ServiceTicket): string | number {
  const customer = ticket.customerInfo;
  
  // Map placeholders to actual data
  const mappings: { [key: string]: string | number } = {
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
    '(Billable Rate)': 130,
    '(Field Time Rate)': 140,
  };
  
  return mappings[placeholder] || '';
}

/**
 * Generates a filled Excel file from the template and ticket data using ExcelJS
 */
export async function generateExcelServiceTicket(ticket: ServiceTicket): Promise<Uint8Array> {
  try {
    // Fetch the template
    const templateResponse = await fetch('/templates/service-ticket-template.xlsx');
    if (!templateResponse.ok) {
      throw new Error('Failed to fetch Excel template');
    }
    
    const templateBytes = await templateResponse.arrayBuffer();
    
    // Load workbook with ExcelJS
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(templateBytes);
    
    console.log('📊 Template loaded - Images:', workbook.model?.media?.length || 0, 'images found');
    
    // Get the mapping from DB_25101 sheet
    const mapping = await parseExcelTemplateMapping();
    
    // Get the Template sheet (the one we'll fill and export)
    const worksheet = workbook.getWorksheet('Template');
    if (!worksheet) {
      throw new Error('Template sheet not found in workbook');
    }
    
    // Fill in header fields using the mapping
    for (const [placeholder, cellAddresses] of Object.entries(mapping)) {
      const value = getFieldValueForPlaceholder(placeholder, ticket);
      
      // Skip if no value
      if (!value) continue;
      
      // Fill all cells that use this placeholder
      for (const cellAddress of cellAddresses) {
        const cell = worksheet.getCell(cellAddress);
        // Only update the value - ExcelJS preserves all formatting automatically
        cell.value = value;
      }
    }
    
    // Fill in the ticket number (M1 in Template sheet)
    // Note: M1 has a complex _xlfn formula that causes corruption - replace with simple text
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    const ticketCell = worksheet.getCell('M1');
    // Set as plain string value (this clears any formula)
    ticketCell.value = ticketId;
    
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
      
      // Description - ExcelJS preserves cell formatting automatically
      const descAddr = createCellAddress(currentRow, descriptionCol);
      const descCell = worksheet.getCell(descAddr);
      descCell.value = entry.description || 'No description';
      
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
      const hoursCell = worksheet.getCell(hoursAddr);
      hoursCell.value = entry.hours;
      
      currentRow++;
    }
    
    // The totals row (row 24) has formulas that will auto-calculate
    // ExcelJS preserves them automatically
    
    // DON'T remove DB_25101 - removing sheets can strip images from the workbook
    // We'll hide it instead
    const dbSheet = workbook.getWorksheet('DB_25101');
    if (dbSheet) {
      dbSheet.state = 'hidden'; // Hide instead of remove
      console.log('🔒 Hidden DB_25101 sheet instead of removing');
    }
    
    // Fix any problematic _xlfn formulas that cause Excel corruption
    // These are modern Excel functions that ExcelJS doesn't fully support
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.formula) {
          const formulaStr = typeof cell.formula === 'string' ? cell.formula : (cell.formula as any).formula;
          if (formulaStr && formulaStr.includes('_xlfn')) {
            // Replace with result value to avoid corruption
            const result = typeof cell.formula === 'object' ? (cell.formula as any).result : cell.result;
            if (result !== undefined && result !== null) {
              cell.value = result;
            }
          }
        }
      });
    });
    
    // Generate the output file - ExcelJS preserves all formatting, borders, images
    console.log('📝 Before write - Images:', workbook.model?.media?.length || 0, 'images');
    console.log('📝 Template sheet images:', worksheet.getImages ? worksheet.getImages().length : 'N/A');
    
    const buffer = await workbook.xlsx.writeBuffer({
      useStyles: true,
      useSharedStrings: true,
    });
    
    console.log('✅ Write complete - Buffer size:', buffer.byteLength, 'bytes');
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
