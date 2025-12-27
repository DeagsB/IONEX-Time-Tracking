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
    
    // Get the Template sheet (the one we'll fill and export)
    const worksheet = workbook.getWorksheet('Template');
    if (!worksheet) {
      throw new Error('Template sheet not found in workbook');
    }
    
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
    // C9: Job ID - use the project number assigned to the project
    const jobId = ticket.projectNumber || ticket.projectName || 'N/A';
    setCellValue('C9', jobId);
    setCellValue('C10', ticket.userName);
    const dateStr = new Date(ticket.date).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    });
    setCellValue('C11', dateStr);
    
    // Fill in the ticket number (M1 in Template sheet)
    // Format: {initials}_{YY}{sequence} e.g., "DB_25001"
    // The ticketNumber should be passed in, or we generate a placeholder
    const ticketNumber = ticket.ticketNumber || `${ticket.userInitials}_${new Date().getFullYear() % 100}XXX`;
    const ticketCell = worksheet.getCell('M1');
    // ExcelJS bug workaround: Force model update
    (ticketCell as any).model = {
      ...((ticketCell as any).model || {}),
      value: ticketNumber,
      type: 6 // sharedString/text
    };
    ticketCell.value = ticketNumber;
    
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
        break; // Too many entries to fit in single sheet
      }
      
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
      
      currentRow++;
    }
    
    // Pre-calculate totals for each rate type column
    // This ensures values show in Protected View (before enabling editing)
    
    // Calculate totals from our entries
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
        rtTotal += entry.hours; // Shop Time (Regular)
      }
    }
    
    // Row 24 typically has the totals - set formula results
    // Find and update formula cells with their calculated results
    const totalsRow = 24;
    const rateColumns = {
      'K': rtTotal,  // RT column
      'L': ttTotal,  // TT column
      'M': ftTotal,  // FT column
      'N': otTotal   // OT column
    };
    
    for (const [col, total] of Object.entries(rateColumns)) {
      const addr = `${col}${totalsRow}`;
      const cell = worksheet.getCell(addr);
      
      // If cell has a formula, preserve it but add the cached result
      if (cell.formula) {
        const formulaStr = typeof cell.formula === 'string' ? cell.formula : (cell.formula as any).formula;
        // Set formula with result for Protected View compatibility
        cell.value = { formula: formulaStr, result: total };
      } else if (total > 0) {
        // No formula - just set the value
        setCellValue(addr, total);
      }
    }
    
    // Pre-calculate summary cells for Protected View
    // Calculate dollar amounts directly from hours * rates
    // Standard rates: RT=$130/hr, TT=$130/hr, FT=$140/hr, OT=$195/hr (1.5x RT)
    const rtRate = 130;
    const ttRate = 130;
    const ftRate = 140;
    const otRate = 195;
    
    const rtAmount = rtTotal * rtRate;
    const ttAmount = ttTotal * ttRate;
    const ftAmount = ftTotal * ftRate;
    const otAmount = otTotal * otRate;
    const grandTotal = rtAmount + ttAmount + ftAmount + otAmount;
    
    // M35 = RT Amount, M36 = TT Amount, M37 = FT Amount, M40 = Grand Total
    const summaryValues: { [addr: string]: number } = {
      'M35': rtAmount,
      'M36': ttAmount, 
      'M37': ftAmount,
      'M38': otAmount,
      'M40': grandTotal
    };
    
    for (const [addr, amount] of Object.entries(summaryValues)) {
      const cell = worksheet.getCell(addr);
      if (cell.formula) {
        const formulaStr = typeof cell.formula === 'string' ? cell.formula : (cell.formula as any).formula;
        // Preserve formula but add cached result for Protected View
        cell.value = { formula: formulaStr, result: amount };
      } else {
        // No formula - just set the value directly
        setCellValue(addr, amount);
      }
    }
    
    // DON'T remove DB_25101 - removing sheets can strip images from the workbook
    // We'll hide it instead
    const dbSheet = workbook.getWorksheet('DB_25101');
    if (dbSheet) {
      dbSheet.state = 'hidden'; // Hide instead of remove
    }
    
    // Fix any problematic _xlfn formulas that cause Excel corruption
    // And cache results for all formulas to work in Protected View
    worksheet.eachRow((row, rowNumber) => {
      row.eachCell((cell, colNumber) => {
        if (cell.formula) {
          const formulaStr = typeof cell.formula === 'string' ? cell.formula : (cell.formula as any).formula;
          const currentResult = typeof cell.formula === 'object' ? (cell.formula as any).result : cell.result;
          
          if (formulaStr && formulaStr.includes('_xlfn')) {
            // Replace _xlfn formulas with result value to avoid corruption
            if (currentResult !== undefined && currentResult !== null) {
              cell.value = currentResult;
            }
          } else if (formulaStr && currentResult === undefined) {
            // For formulas without cached results, try to compute simple ones
            // This handles SUM formulas which are most common
            if (formulaStr.startsWith('SUM(')) {
              const match = formulaStr.match(/SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)/);
              if (match) {
                const [, startCol, startRow, endCol, endRow] = match;
                let sum = 0;
                for (let r = parseInt(startRow); r <= parseInt(endRow); r++) {
                  const val = worksheet.getCell(`${startCol}${r}`).value;
                  if (typeof val === 'number') sum += val;
                }
                cell.value = { formula: formulaStr, result: sum };
              }
            }
          }
        }
      });
    });
    
    // Ensure Excel recalculates formulas when opening (for when editing is enabled)
    if (workbook.calcProperties) {
      workbook.calcProperties.fullCalcOnLoad = true;
    }
    
    // Generate the output file - ExcelJS preserves all formatting, borders, images
    const buffer = await workbook.xlsx.writeBuffer();
    
    return new Uint8Array(buffer);
    
  } catch (error) {
    throw error;
  }
}

/**
 * Downloads the generated Excel file
 */
export async function downloadExcelServiceTicket(ticket: ServiceTicket): Promise<void> {
  const excelBytes = await generateExcelServiceTicket(ticket);
  
  const blob = new Blob([excelBytes as any], { 
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
  });
  
  // Use ticket number if available, otherwise generate a fallback ID
  const ticketId = ticket.ticketNumber || 
    `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
  const fileName = `ServiceTicket_${ticketId}_${ticket.customerName.replace(/\s+/g, '_')}.xlsx`;
  
  saveAs(blob, fileName);
}
