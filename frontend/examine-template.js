import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, 'public', 'templates', 'service-ticket-template.xlsx');

console.log('Reading template from:', templatePath);

const workbook = XLSX.readFile(templatePath);
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];

console.log('\n📊 Sheet Name:', sheetName);
console.log('\n📋 Template Structure:\n');

// Get the range
const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');

// Print all cells with content
for (let row = range.s.r; row <= range.e.r; row++) {
  let rowContent = {};
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
    const cell = worksheet[cellAddress];
    if (cell && cell.v !== undefined && cell.v !== '') {
      rowContent[cellAddress] = cell.v;
    }
  }
  if (Object.keys(rowContent).length > 0) {
    console.log(`Row ${row + 1}:`, JSON.stringify(rowContent, null, 2));
  }
}

console.log('\n✅ Template examination complete!');

