import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { ServiceTicket } from './serviceTickets';
import { createCellAddress } from './excelTemplateMapping';

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
    
    // Template loaded successfully with images preserved
    console.log('🎫 Ticket data:', {
      customer: ticket.customerName,
      date: ticket.date,
      user: ticket.userName,
      entries: ticket.entries.length,
      totalHours: ticket.totalHours
    });
    
    // Get the Template sheet (the one we'll fill and export)
    const worksheet = workbook.getWorksheet('Template');
    if (!worksheet) {
      throw new Error('Template sheet not found in workbook');
    }
    
    // Fill in header fields using hardcoded positions
    // (The DB_25101 mapping sheet may not exist after logo update)
    console.log('📋 Filling header fields with hardcoded positions');
    
    const customer = ticket.customerInfo;
    
    // Helper function to set cell value with ExcelJS bug workaround
    const setCellValue = (address: string, value: string | number) => {
      const cell = worksheet.getCell(address);
      (cell as any).model = {
        ...((cell as any).model || {}),
        value: typeof value === 'number' ? value : String(value),
        type: typeof value === 'number' ? 2 : 6
      };
      cell.value = value;
      console.log(`  ✓ Set ${address} = "${value}"`);
    };
    
    // Customer information (right side of template)
    if (customer.name) setCellValue('I3', customer.name);
    if (customer.address) setCellValue('I4', customer.address);
    const cityState = customer.city && customer.state 
      ? `${customer.city}, ${customer.state}` 
      : customer.city || customer.state || '';
    if (cityState) {
      setCellValue('I5', cityState);
      // Left-justify city/province
      const cityCell = worksheet.getCell('I5');
      cityCell.alignment = { horizontal: 'left', vertical: 'middle' };
    }
    if (customer.zip_code) setCellValue('I6', customer.zip_code);
    if (ticket.userName) setCellValue('I7', ticket.userName);
    if (customer.phone) setCellValue('I8', customer.phone);
    if (customer.email) setCellValue('I9', customer.email);
    const location = customer.service_location || customer.address || '';
    if (location) setCellValue('I10', location);
    if (customer.location_code) setCellValue('L10', customer.location_code);
    if (customer.po_number) {
      setCellValue('I11', customer.po_number);
      setCellValue('C37', customer.po_number);
    }
    if (customer.approver_name) {
      setCellValue('L11', customer.approver_name);
      setCellValue('C35', customer.approver_name);
    }
    
    // Left side fields
    const jobId = ticket.entries[0]?.id.substring(0, 8) || 'AUTO';
    setCellValue('C9', jobId);
    setCellValue('C10', ticket.userName);
    const dateStr = new Date(ticket.date).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    });
    setCellValue('C11', dateStr);
    
    // Fill in the ticket number (M1 in Template sheet)
    // Note: M1 has a complex _xlfn formula that causes corruption - replace with simple text
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    const ticketCell = worksheet.getCell('M1');
    // ExcelJS bug workaround: Force model update
    (ticketCell as any).model = {
      ...((ticketCell as any).model || {}),
      value: ticketId,
      type: 6 // sharedString/text
    };
    ticketCell.value = ticketId;
    
    // Fill in line items (starting at row 14, based on DB_25101 structure)
    const firstDataRow = 14;
    const lastDataRow = 23; // 10 rows available
    const descriptionCol = 'B';
    const rtCol = 'K';
    const ttCol = 'L';
    const ftCol = 'M';
    const otCol = 'N';
    
    console.log(`\n📝 Filling ${ticket.entries.length} time entries (rows ${firstDataRow}-${lastDataRow}):`);
    
    let currentRow = firstDataRow;
    for (const entry of ticket.entries) {
      if (currentRow > lastDataRow) {
        console.warn('⚠️ Too many entries to fit in single sheet, truncating...');
        break;
      }
      
      console.log(`\n  Entry ${currentRow - firstDataRow + 1}:`);
      console.log(`    Description: "${entry.description}"`);
      console.log(`    Hours: ${entry.hours}`);
      console.log(`    Rate Type: ${entry.rate_type || 'Shop Time'}`);
      
      // Description - ExcelJS preserves cell formatting automatically
      const descAddr = createCellAddress(currentRow, descriptionCol);
      const descCell = worksheet.getCell(descAddr);
      const descValue = entry.description || 'No description';
      // ExcelJS bug workaround: Force model update
      (descCell as any).model = {
        ...((descCell as any).model || {}),
        value: String(descValue),
        type: 6 // sharedString/text
      };
      descCell.value = descValue;
      console.log(`    ✓ Set ${descAddr} = "${descValue}" (type: ${descCell.type}, text: ${descCell.text})`);
      
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
      // ExcelJS bug workaround: Force model update
      (hoursCell as any).model = {
        ...((hoursCell as any).model || {}),
        value: entry.hours,
        type: 2 // number
      };
      hoursCell.value = entry.hours;
      console.log(`    ✓ Set ${hoursAddr} (${rateType}) = ${entry.hours} hrs (type: ${hoursCell.type}, text: ${hoursCell.text})`);
      
      currentRow++;
    }
    
    console.log(`\n✅ Filled ${currentRow - firstDataRow} time entries total`);
    
    // Verify values are in the worksheet before writing
    console.log('\n🔍 Verification - Reading back values:');
    console.log('  I3 (Customer):', worksheet.getCell('I3').value);
    console.log('  C9 (Job ID):', worksheet.getCell('C9').value);
    console.log('  C10 (Tech):', worksheet.getCell('C10').value);
    console.log('  B14 (First entry):', worksheet.getCell('B14').value);
    console.log('  K14 (First hours):', worksheet.getCell('K14').value);
    
    // The totals row (row 24) has formulas that will auto-calculate
    // ExcelJS preserves them automatically
    
    // DON'T remove DB_25101 - removing sheets can strip images from the workbook
    // We'll hide it instead
    const dbSheet = workbook.getWorksheet('DB_25101');
    if (dbSheet) {
      dbSheet.state = 'hidden'; // Hide instead of remove
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
    
    // Ensure Excel recalculates formulas when opening
    if (workbook.calcProperties) {
      workbook.calcProperties.fullCalcOnLoad = true;
    }
    
    // Log workbook state before writing
    console.log('📦 About to write workbook with sheets:', workbook.worksheets.map(ws => `${ws.name} (${ws.state})`));
    console.log('📝 Template sheet has', worksheet.rowCount, 'rows');
    
    // Generate the output file - ExcelJS preserves all formatting, borders, images
    // Remove useStyles/useSharedStrings options which can cause data loss
    const buffer = await workbook.xlsx.writeBuffer();
    console.log('✅ Buffer generated, size:', buffer.byteLength, 'bytes');
    
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
    console.log('🔽 Starting download...');
    const excelBytes = await generateExcelServiceTicket(ticket);
    console.log('📊 Generated Excel bytes:', excelBytes.byteLength);
    
    const blob = new Blob([excelBytes as any], { 
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
    });
    console.log('📦 Blob created, size:', blob.size);
    
    const ticketId = `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
    const fileName = `ServiceTicket_${ticketId}_${ticket.customerName.replace(/\s+/g, '_')}.xlsx`;
    
    console.log('💾 Saving file as:', fileName);
    saveAs(blob, fileName);
    console.log('✅ File download initiated');
  } catch (error) {
    console.error('Error downloading Excel service ticket:', error);
    throw error;
  }
}
