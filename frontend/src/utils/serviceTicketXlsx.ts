import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { ServiceTicket, getRateTypeSortOrder } from './serviceTickets';
import { createCellAddress } from './excelTemplateMapping';

// Maximum characters per description row before wrapping to next row
// This is based on the column width of the description area (B-J merged)
const MAX_DESCRIPTION_CHARS = 75;

// Round UP to nearest 0.5 hour (never round down)
const roundToHalfHour = (hours: number): number => {
  return Math.ceil(hours * 2) / 2;
};

/**
 * Splits a description into multiple lines based on max character limit
 * Splits at word boundaries when possible
 */
function splitDescription(description: string, maxChars: number): string[] {
  if (!description || description.length <= maxChars) {
    return [description || 'No description'];
  }

  const lines: string[] = [];
  let remaining = description;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      lines.push(remaining);
      break;
    }

    // Find a good break point (space) near the max length
    let breakPoint = maxChars;
    const lastSpace = remaining.lastIndexOf(' ', maxChars);
    
    if (lastSpace > maxChars * 0.5) {
      // Found a space in the latter half - use it
      breakPoint = lastSpace;
    }

    lines.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }

  return lines;
}

/**
 * Represents a row item to be written to the Excel sheet
 */
interface RowItem {
  description: string;
  hours: number | null; // null means continuation row (no hours)
  rateType: string;
  isFirstLineOfEntry: boolean;
}

/**
 * Prepares row items from entries, splitting long descriptions across rows
 */
function prepareRowItems(entries: ServiceTicket['entries']): RowItem[] {
  const rowItems: RowItem[] = [];

  // Sort entries by rate type order: Shop Time, Field Time, Travel Time, then Overtime
  const sortedEntries = [...entries].sort((a, b) => {
    const rateTypeA = a.rate_type || 'Shop Time';
    const rateTypeB = b.rate_type || 'Shop Time';
    const orderA = getRateTypeSortOrder(rateTypeA);
    const orderB = getRateTypeSortOrder(rateTypeB);
    
    // If same order, maintain original order
    if (orderA === orderB) {
      return 0;
    }
    
    return orderA - orderB;
  });

  for (const entry of sortedEntries) {
    const descriptionLines = splitDescription(entry.description || 'No description', MAX_DESCRIPTION_CHARS);
    const rateType = entry.rate_type || 'Shop Time';

    for (let i = 0; i < descriptionLines.length; i++) {
      rowItems.push({
        description: descriptionLines[i],
        hours: i === 0 ? roundToHalfHour(entry.hours) : null, // Only first line gets hours, rounded to 0.5
        rateType: rateType,
        isFirstLineOfEntry: i === 0,
      });
    }
  }

  return rowItems;
}

/**
 * Fills a worksheet with header information (customer info, dates, etc.)
 */
function fillHeaderInfo(
  worksheet: ExcelJS.Worksheet,
  ticket: ServiceTicket,
  pageNumber: number,
  totalPages: number
) {
  const customer = ticket.customerInfo;

  // Helper function to set cell value with ExcelJS bug workaround
  const setCellValue = (address: string, value: string | number) => {
    const cell = worksheet.getCell(address);
    (cell as any).model = {
      ...((cell as any).model || {}),
      value: typeof value === 'number' ? value : String(value),
      type: typeof value === 'number' ? 2 : 6,
    };
    cell.value = value;
  };

  // Customer information (right side of template)
  if (customer.name) setCellValue('I3', customer.name);
  if (customer.address) setCellValue('I4', customer.address);
  const cityState =
    customer.city && customer.state
      ? `${customer.city}, ${customer.state}`
      : customer.city || customer.state || '';
  if (cityState) {
    setCellValue('I5', cityState);
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
  const jobId = ticket.projectNumber || ticket.projectName || 'N/A';
  setCellValue('C9', jobId);
  setCellValue('C10', ticket.userName);
  const dateStr = new Date(ticket.date).toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  });
  setCellValue('C11', dateStr);
  setCellValue('E9', 'AUTO');

  // Ticket number with page indicator if multiple pages
  const ticketNumber =
    ticket.ticketNumber || `${ticket.userInitials}_${new Date().getFullYear() % 100}XXX`;
  const displayTicketNumber = totalPages > 1 ? `${ticketNumber} (${pageNumber}/${totalPages})` : ticketNumber;
  
  const ticketCell = worksheet.getCell('M1');
  (ticketCell as any).model = {
    ...((ticketCell as any).model || {}),
    value: displayTicketNumber,
    type: 6,
  };
  ticketCell.value = displayTicketNumber;
}

/**
 * Fills row items into the description area of a worksheet
 * Returns the hours totals for this page
 */
function fillRowItems(
  worksheet: ExcelJS.Worksheet,
  rowItems: RowItem[],
  startIndex: number,
  maxRows: number
): { endIndex: number; rtTotal: number; ttTotal: number; ftTotal: number; shopOtTotal: number; fieldOtTotal: number } {
  const firstDataRow = 14;
  const descriptionCol = 'B';
  const rtCol = 'K';
  const ttCol = 'L';
  const ftCol = 'M';
  const otCol = 'N';

  let rtTotal = 0,
    ttTotal = 0,
    ftTotal = 0,
    shopOtTotal = 0,
    fieldOtTotal = 0;
  let currentRow = firstDataRow;
  let itemIndex = startIndex;

  // Helper function to set cell value
  const setCellValue = (address: string, value: string | number) => {
    const cell = worksheet.getCell(address);
    (cell as any).model = {
      ...((cell as any).model || {}),
      value: typeof value === 'number' ? value : String(value),
      type: typeof value === 'number' ? 2 : 6,
    };
    cell.value = value;
  };

  while (itemIndex < rowItems.length && currentRow <= firstDataRow + maxRows - 1) {
    const item = rowItems[itemIndex];

    // Set description
    const descAddr = createCellAddress(currentRow, descriptionCol);
    setCellValue(descAddr, item.description);

    // Set hours if this is the first line of an entry (already rounded to 0.5)
    if (item.hours !== null) {
      const roundedHours = roundToHalfHour(item.hours); // Ensure rounding is applied
      let hoursCol = rtCol;
      if (item.rateType === 'Travel Time') {
        hoursCol = ttCol;
        ttTotal += roundedHours;
      } else if (item.rateType === 'Field Time') {
        hoursCol = ftCol;
        ftTotal += roundedHours;
      } else if (item.rateType === 'Shop Overtime') {
        hoursCol = otCol;
        shopOtTotal += roundedHours;
      } else if (item.rateType === 'Field Overtime') {
        hoursCol = otCol;
        fieldOtTotal += roundedHours;
      } else {
        rtTotal += roundedHours;
      }

      const hoursAddr = createCellAddress(currentRow, hoursCol);
      setCellValue(hoursAddr, roundedHours);
    }

    currentRow++;
    itemIndex++;
  }

  return { endIndex: itemIndex, rtTotal, ttTotal, ftTotal, shopOtTotal, fieldOtTotal };
}

/**
 * Fills expenses into the Excel template
 * Expenses start at row 27: B27=Description, I27=Rate, K27=Quantity, M27=Subtotal (I27*K27)
 * Returns the total expenses and the last row used
 */
function fillExpenses(
  worksheet: ExcelJS.Worksheet,
  expenses: Array<{
    expense_type: string;
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  }>,
  startRow: number = 27
): { total: number; lastRow: number } {
  expenses.forEach((expense, index) => {
    const row = startRow + index;
    const description = expense.description || '';
    const rate = expense.rate || 0;
    const quantity = expense.quantity || 0;

    // B27 = Description, I27 = Rate, K27 = Quantity, M27 = Subtotal (formula: I27*K27)
    worksheet.getCell(`B${row}`).value = description;
    worksheet.getCell(`I${row}`).value = rate;
    worksheet.getCell(`K${row}`).value = quantity;
    
    // Set subtotal as formula: I27*K27
    worksheet.getCell(`M${row}`).value = { formula: `I${row}*K${row}`, result: quantity * rate };

    // Format currency cells
    worksheet.getCell(`I${row}`).numFmt = '$#,##0.00';
    worksheet.getCell(`M${row}`).numFmt = '$#,##0.00';
  });

  const total = expenses.reduce((sum, e) => sum + (e.quantity * e.rate), 0);
  const lastRow = expenses.length > 0 ? startRow + expenses.length - 1 : startRow;

  // Set expense total in M32 (not M31) - sum only the expense subtotals
  if (expenses.length > 0) {
    const firstSubtotalCell = `M${startRow}`;
    const lastSubtotalCell = `M${lastRow}`;
    
    // M32 should sum only the expense subtotals (e.g., =IF(SUM(M27:M30)>0, SUM(M27:M30),""))
    const expenseTotalCell = worksheet.getCell('M32');
    const sumFormula = `IF(SUM(${firstSubtotalCell}:${lastSubtotalCell})>0, SUM(${firstSubtotalCell}:${lastSubtotalCell}), "")`;
    expenseTotalCell.value = { formula: sumFormula, result: total };
    expenseTotalCell.numFmt = '$#,##0.00';
  } else {
    // If no expenses, clear M32
    const expenseTotalCell = worksheet.getCell('M32');
    expenseTotalCell.value = '';
  }

  return { total, lastRow };
}

/**
 * Updates formula cells with calculated totals for Protected View compatibility
 */
function updateTotals(
  worksheet: ExcelJS.Worksheet,
  rtTotal: number,
  ttTotal: number,
  ftTotal: number,
  shopOtTotal: number,
  fieldOtTotal: number,
  rates: { rt: number; tt: number; ft: number; shop_ot: number; field_ot: number },
  expensesTotal: number = 0
) {
  const totalsRow = 24;
  const rtRate = rates.rt;
  const ttRate = rates.tt;
  const ftRate = rates.ft;
  const shopOtRate = rates.shop_ot;
  const fieldOtRate = rates.field_ot;

  const rtAmount = rtTotal * rtRate;
  const ttAmount = ttTotal * ttRate;
  const ftAmount = ftTotal * ftRate;
  const shopOtAmount = shopOtTotal * shopOtRate;
  const fieldOtAmount = fieldOtTotal * fieldOtRate;
  const otTotal = shopOtTotal + fieldOtTotal;
  const otAmount = shopOtAmount + fieldOtAmount;
  const grandTotal = rtAmount + ttAmount + ftAmount + otAmount + expensesTotal;

  // Helper to set cell with formula result caching
  const setCellWithResult = (address: string, value: number) => {
    const cell = worksheet.getCell(address);
    if (cell.formula) {
      const formulaStr = typeof cell.formula === 'string' ? cell.formula : (cell.formula as any).formula;
      cell.value = { formula: formulaStr, result: value };
    } else {
      (cell as any).model = {
        ...((cell as any).model || {}),
        value: value,
        type: 2,
      };
      cell.value = value;
    }
  };

  // Row 24 - Employee rates display
  setCellWithResult('C24', rtRate);  // Regular Time rate
  setCellWithResult('E24', ftRate);  // Field Time rate

  // Row 24 totals - explicitly format to show decimals
  setCellWithResult(`K${totalsRow}`, rtTotal);
  setCellWithResult(`L${totalsRow}`, ttTotal);
  setCellWithResult(`M${totalsRow}`, ftTotal);
  setCellWithResult(`N${totalsRow}`, otTotal); // Combined OT total for display
  
  // Ensure totals display with 1 decimal place
  ['K', 'L', 'M', 'N'].forEach(col => {
    const cell = worksheet.getCell(`${col}${totalsRow}`);
    cell.numFmt = '0.0';
  });

  // Write rate values to cells (L column typically shows $/hr rates)
  setCellWithResult('L35', rtRate);
  setCellWithResult('L36', ttRate);
  setCellWithResult('L37', ftRate);
  setCellWithResult('L38', otRate);

  // Summary cells (amounts)
  setCellWithResult('M35', rtAmount);
  setCellWithResult('M36', ttAmount);
  setCellWithResult('M37', ftAmount);
  setCellWithResult('M38', otAmount);
  setCellWithResult('M39', expensesTotal); // Total Expenses
  setCellWithResult('M40', grandTotal);
}

/**
 * Generates a filled Excel file from the template and ticket data using ExcelJS
 * Handles multi-page output when descriptions overflow
 */
export async function generateExcelServiceTicket(
  ticket: ServiceTicket,
  expenses: Array<{
    expense_type: string;
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  }> = []
): Promise<Uint8Array> {
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

    // Get the Template sheet
    const templateSheet = workbook.getWorksheet('Template');
    if (!templateSheet) {
      throw new Error('Template sheet not found in workbook');
    }

    // Prepare row items with split descriptions
    const rowItems = prepareRowItems(ticket.entries);
    const maxRowsPerPage = 10; // Rows 14-23

    // Calculate how many pages we need
    const totalPages = Math.ceil(rowItems.length / maxRowsPerPage);

    if (totalPages === 1) {
      // Single page - simple case
      fillHeaderInfo(templateSheet, ticket, 1, 1);
      const { rtTotal, ttTotal, ftTotal, shopOtTotal, fieldOtTotal } = fillRowItems(
        templateSheet,
        rowItems,
        0,
        maxRowsPerPage
      );
      const { total: expensesTotal } = fillExpenses(templateSheet, expenses);
      updateTotals(templateSheet, rtTotal, ttTotal, ftTotal, shopOtTotal, fieldOtTotal, ticket.rates, expensesTotal);
    } else {
      // Multi-page - need to duplicate sheets
      let currentItemIndex = 0;
      let cumulativeRtTotal = 0,
        cumulativeTtTotal = 0,
        cumulativeFtTotal = 0,
        cumulativeShopOtTotal = 0,
        cumulativeFieldOtTotal = 0;

      for (let page = 1; page <= totalPages; page++) {
        let worksheet: ExcelJS.Worksheet;

        if (page === 1) {
          // Use the original template sheet for first page
          worksheet = templateSheet;
        } else {
          // Duplicate the template sheet for additional pages
          // ExcelJS doesn't have a direct copy method, so we need to manually copy
          const newSheetName = `Page ${page}`;
          
          // We'll load a fresh copy of the template for each additional page
          const freshWorkbook = new ExcelJS.Workbook();
          await freshWorkbook.xlsx.load(templateBytes);
          const freshTemplate = freshWorkbook.getWorksheet('Template');
          
          if (!freshTemplate) {
            throw new Error('Template sheet not found for page duplication');
          }

          // Add the sheet to our main workbook
          worksheet = workbook.addWorksheet(newSheetName);
          
          // Copy row heights and column widths
          freshTemplate.columns.forEach((col, index) => {
            if (worksheet.columns[index]) {
              worksheet.columns[index].width = col.width;
            }
          });
          
          // Copy cells
          freshTemplate.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            const newRow = worksheet.getRow(rowNumber);
            newRow.height = row.height;
            
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
              const newCell = newRow.getCell(colNumber);
              
              // Copy value
              newCell.value = cell.value;
              
              // Copy style
              newCell.style = JSON.parse(JSON.stringify(cell.style || {}));
              
              // Copy merge info will be handled separately
            });
          });

          // Copy merged cells
          freshTemplate.model.merges?.forEach((merge: string) => {
            try {
              worksheet.mergeCells(merge);
            } catch (e) {
              // Ignore merge errors for already merged cells
            }
          });
        }

        // Fill header info for this page
        fillHeaderInfo(worksheet, ticket, page, totalPages);

        // Fill row items for this page
        const result = fillRowItems(worksheet, rowItems, currentItemIndex, maxRowsPerPage);
        currentItemIndex = result.endIndex;

        // Accumulate totals
        cumulativeRtTotal += result.rtTotal;
        cumulativeTtTotal += result.ttTotal;
        cumulativeFtTotal += result.ftTotal;
        cumulativeShopOtTotal += result.shopOtTotal;
        cumulativeFieldOtTotal += result.fieldOtTotal;

        // Fill expenses only on the last page
        const expensesTotal = page === totalPages ? fillExpenses(worksheet, expenses).total : 0;

        // For intermediate pages, show page totals
        // For last page, show cumulative totals
        if (page === totalPages) {
          updateTotals(worksheet, cumulativeRtTotal, cumulativeTtTotal, cumulativeFtTotal, cumulativeShopOtTotal, cumulativeFieldOtTotal, ticket.rates, expensesTotal);
        } else {
          // Show this page's totals (no expenses on intermediate pages)
          updateTotals(worksheet, result.rtTotal, result.ttTotal, result.ftTotal, result.shopOtTotal, result.fieldOtTotal, ticket.rates, 0);
        }
      }
    }

    // Hide the DB_25101 sheet (don't remove - keeps images)
    const dbSheet = workbook.getWorksheet('DB_25101');
    if (dbSheet) {
      dbSheet.state = 'hidden';
    }

    // Fix _xlfn formulas and cache results for Protected View
    workbook.worksheets.forEach((ws) => {
      if (ws.state === 'hidden') return;
      
      ws.eachRow((row, rowNumber) => {
        row.eachCell((cell, colNumber) => {
          if (cell.formula) {
            const formulaStr =
              typeof cell.formula === 'string' ? cell.formula : (cell.formula as any).formula;
            const currentResult =
              typeof cell.formula === 'object' ? (cell.formula as any).result : cell.result;

            if (formulaStr && formulaStr.includes('_xlfn')) {
              if (currentResult !== undefined && currentResult !== null) {
                cell.value = currentResult;
              }
            } else if (formulaStr && currentResult === undefined) {
              if (formulaStr.startsWith('SUM(')) {
                const match = formulaStr.match(/SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)/);
                if (match) {
                  const [, startCol, startRow, endCol, endRow] = match;
                  let sum = 0;
                  for (let r = parseInt(startRow); r <= parseInt(endRow); r++) {
                    const val = ws.getCell(`${startCol}${r}`).value;
                    if (typeof val === 'number') sum += val;
                  }
                  cell.value = { formula: formulaStr, result: sum };
                }
              }
            }
          }
        });
      });
    });

    // Ensure Excel recalculates formulas when opening
    if (workbook.calcProperties) {
      workbook.calcProperties.fullCalcOnLoad = true;
    }

    // Generate the output file
    const buffer = await workbook.xlsx.writeBuffer();

    return new Uint8Array(buffer);
  } catch (error) {
    throw error;
  }
}

/**
 * Downloads the generated Excel file
 */
export async function downloadExcelServiceTicket(
  ticket: ServiceTicket,
  expenses: Array<{
    expense_type: string;
    description: string;
    quantity: number;
    rate: number;
    unit?: string;
  }> = []
): Promise<void> {
  // #region agent log
  console.log('[DEBUG] downloadExcelServiceTicket ENTRY', {ticketNumber:ticket.ticketNumber,customerName:ticket.customerName,entriesCount:ticket.entries?.length,hasRates:!!ticket.rates});
  fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'serviceTicketXlsx.ts:558',message:'downloadExcelServiceTicket ENTRY',data:{ticketNumber:ticket.ticketNumber,customerName:ticket.customerName,entriesCount:ticket.entries?.length,hasRates:!!ticket.rates},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
  // #endregion
  const excelBytes = await generateExcelServiceTicket(ticket, expenses);
  // #region agent log
  console.log('[DEBUG] generateExcelServiceTicket completed', {bytesLength:excelBytes?.length});
  fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'serviceTicketXlsx.ts:565',message:'generateExcelServiceTicket completed',data:{bytesLength:excelBytes?.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
  // #endregion

  const blob = new Blob([excelBytes as any], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  // Use ticket number if available, otherwise generate a fallback ID
  const ticketId =
    ticket.ticketNumber ||
    `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
  const fileName = `ServiceTicket_${ticketId}_${ticket.customerName.replace(/\s+/g, '_')}.xlsx`;
  // #region agent log
  console.log('[DEBUG] About to trigger download', {fileName,blobSize:blob.size});
  fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'serviceTicketXlsx.ts:580',message:'About to trigger download',data:{fileName,blobSize:blob.size},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
  // #endregion

  saveAs(blob, fileName);
  console.log('[DEBUG] saveAs called for', fileName);
}
