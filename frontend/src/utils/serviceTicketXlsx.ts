import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { ServiceTicket } from './serviceTickets';
import { createCellAddress } from './excelTemplateMapping';

// Maximum characters per description row before wrapping to next row
// This is based on the column width of the description area (B-J merged)
const MAX_DESCRIPTION_CHARS = 75;

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

  for (const entry of entries) {
    const descriptionLines = splitDescription(entry.description || 'No description', MAX_DESCRIPTION_CHARS);
    const rateType = entry.rate_type || 'Shop Time';

    for (let i = 0; i < descriptionLines.length; i++) {
      rowItems.push({
        description: descriptionLines[i],
        hours: i === 0 ? entry.hours : null, // Only first line gets hours
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
): { endIndex: number; rtTotal: number; ttTotal: number; ftTotal: number; otTotal: number } {
  const firstDataRow = 14;
  const descriptionCol = 'B';
  const rtCol = 'K';
  const ttCol = 'L';
  const ftCol = 'M';
  const otCol = 'N';

  let rtTotal = 0,
    ttTotal = 0,
    ftTotal = 0,
    otTotal = 0;
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

    // Set hours if this is the first line of an entry
    if (item.hours !== null) {
      let hoursCol = rtCol;
      if (item.rateType === 'Travel Time') {
        hoursCol = ttCol;
        ttTotal += item.hours;
      } else if (item.rateType === 'Field Time') {
        hoursCol = ftCol;
        ftTotal += item.hours;
      } else if (item.rateType === 'Shop Overtime' || item.rateType === 'Field Overtime') {
        hoursCol = otCol;
        otTotal += item.hours;
      } else {
        rtTotal += item.hours;
      }

      const hoursAddr = createCellAddress(currentRow, hoursCol);
      setCellValue(hoursAddr, item.hours);
    }

    currentRow++;
    itemIndex++;
  }

  return { endIndex: itemIndex, rtTotal, ttTotal, ftTotal, otTotal };
}

/**
 * Updates formula cells with calculated totals for Protected View compatibility
 */
function updateTotals(
  worksheet: ExcelJS.Worksheet,
  rtTotal: number,
  ttTotal: number,
  ftTotal: number,
  otTotal: number
) {
  const totalsRow = 24;
  const rtRate = 130,
    ttRate = 130,
    ftRate = 140,
    otRate = 195;

  const rtAmount = rtTotal * rtRate;
  const ttAmount = ttTotal * ttRate;
  const ftAmount = ftTotal * ftRate;
  const otAmount = otTotal * otRate;
  const grandTotal = rtAmount + ttAmount + ftAmount + otAmount;

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

  // Row 24 totals
  setCellWithResult(`K${totalsRow}`, rtTotal);
  setCellWithResult(`L${totalsRow}`, ttTotal);
  setCellWithResult(`M${totalsRow}`, ftTotal);
  setCellWithResult(`N${totalsRow}`, otTotal);

  // Summary cells
  setCellWithResult('M35', rtAmount);
  setCellWithResult('M36', ttAmount);
  setCellWithResult('M37', ftAmount);
  setCellWithResult('M38', otAmount);
  setCellWithResult('M40', grandTotal);
}

/**
 * Generates a filled Excel file from the template and ticket data using ExcelJS
 * Handles multi-page output when descriptions overflow
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
      const { rtTotal, ttTotal, ftTotal, otTotal } = fillRowItems(
        templateSheet,
        rowItems,
        0,
        maxRowsPerPage
      );
      updateTotals(templateSheet, rtTotal, ttTotal, ftTotal, otTotal);
    } else {
      // Multi-page - need to duplicate sheets
      let currentItemIndex = 0;
      let cumulativeRtTotal = 0,
        cumulativeTtTotal = 0,
        cumulativeFtTotal = 0,
        cumulativeOtTotal = 0;

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
        cumulativeOtTotal += result.otTotal;

        // For intermediate pages, show page totals
        // For last page, show cumulative totals
        if (page === totalPages) {
          updateTotals(worksheet, cumulativeRtTotal, cumulativeTtTotal, cumulativeFtTotal, cumulativeOtTotal);
        } else {
          // Show this page's totals
          updateTotals(worksheet, result.rtTotal, result.ttTotal, result.ftTotal, result.otTotal);
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
export async function downloadExcelServiceTicket(ticket: ServiceTicket): Promise<void> {
  const excelBytes = await generateExcelServiceTicket(ticket);

  const blob = new Blob([excelBytes as any], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  // Use ticket number if available, otherwise generate a fallback ID
  const ticketId =
    ticket.ticketNumber ||
    `${new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '')}-${ticket.customerName.substring(0, 3).toUpperCase()}`;
  const fileName = `ServiceTicket_${ticketId}_${ticket.customerName.replace(/\s+/g, '_')}.xlsx`;

  saveAs(blob, fileName);
}
