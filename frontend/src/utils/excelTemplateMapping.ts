import * as XLSX from 'xlsx';

/**
 * Maps placeholder text to Excel cell addresses
 */
export interface PlaceholderMapping {
  [placeholder: string]: string[]; // Array because a placeholder might appear in multiple cells
}

/**
 * Converts Excel column letter(s) to column index (0-based)
 * Supports multi-letter columns (AA, AB, etc.)
 */
export function colLetterToIndex(col: string): number {
  let index = 0;
  for (let i = 0; i < col.length; i++) {
    index = index * 26 + (col.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
  }
  return index - 1;
}

/**
 * Converts column index (0-based) to Excel column letter(s)
 */
export function colIndexToLetter(index: number): string {
  let letter = '';
  let num = index + 1;
  while (num > 0) {
    const remainder = (num - 1) % 26;
    letter = String.fromCharCode('A'.charCodeAt(0) + remainder) + letter;
    num = Math.floor((num - 1) / 26);
  }
  return letter;
}

/**
 * Parses the mapping sheet (DB_25101) to find all placeholder cells
 */
export async function parseExcelTemplateMapping(
  templateUrl: string = '/templates/service-ticket-template.xlsx'
): Promise<PlaceholderMapping> {
  try {
    // Fetch the template file
    const response = await fetch(templateUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch template: ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { 
      type: 'array',
      cellText: false,
      cellDates: true 
    });
    
    // Look for the mapping sheet (DB_25101)
    const mappingSheetName = 'DB_25101';
    if (!workbook.SheetNames.includes(mappingSheetName)) {
      console.warn(`Mapping sheet "${mappingSheetName}" not found in template`);
      return {};
    }
    
    const mappingSheet = workbook.Sheets[mappingSheetName];
    const mapping: PlaceholderMapping = {};
    
    // Scan all cells in the mapping sheet
    for (const cellAddress of Object.keys(mappingSheet)) {
      // Skip metadata keys (start with '!')
      if (cellAddress[0] === '!') continue;
      
      const cell = mappingSheet[cellAddress];
      if (!cell || !cell.v) continue;
      
      const value = cell.v;
      
      // Check if it's a placeholder (wrapped in parentheses)
      if (typeof value === 'string' && value.startsWith('(') && value.endsWith(')')) {
        const placeholder = value;
        
        if (!mapping[placeholder]) {
          mapping[placeholder] = [];
        }
        
        // Add this cell address to the mapping
        mapping[placeholder].push(cellAddress);
      }
    }
    
    console.log('📋 Excel Template Mapping:', mapping);
    return mapping;
    
  } catch (error) {
    console.error('Error parsing Excel template mapping:', error);
    throw error;
  }
}

/**
 * Converts Excel cell address to PDF coordinates
 * PDF origin is bottom-left, Excel equivalent row 1 is at top
 */
export function excelCellToPdfCoords(
  cellAddress: string,
  pageHeight: number = 792
): { x: number; y: number } {
  const decoded = XLSX.utils.decode_cell(cellAddress);
  const colIndex = decoded.c;
  const rowIndex = decoded.r; // 0-based
  
  // Excel columns are approximately 47 points wide, starting at x=36
  const x = 36 + (colIndex * 47);
  
  // Excel rows are approximately 15.5 points tall
  // Row 0 (Excel row 1) is at the top, so we subtract from page height
  const y = pageHeight - ((rowIndex + 1) * 15.5);
  
  return { x, y };
}

/**
 * Gets the row number (1-based) from a cell address
 */
export function getRowFromAddress(cellAddress: string): number {
  const decoded = XLSX.utils.decode_cell(cellAddress);
  return decoded.r + 1; // Convert to 1-based
}

/**
 * Gets the column letter from a cell address
 */
export function getColumnFromAddress(cellAddress: string): string {
  const decoded = XLSX.utils.decode_cell(cellAddress);
  return colIndexToLetter(decoded.c);
}

/**
 * Creates a cell address from row and column
 */
export function createCellAddress(row: number, col: number | string): string {
  const colLetter = typeof col === 'number' ? colIndexToLetter(col) : col;
  return `${colLetter}${row}`;
}

