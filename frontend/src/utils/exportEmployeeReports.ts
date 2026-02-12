// Export utilities for Employee Reports
import ExcelJS from 'exceljs';
import html2pdf from 'html2pdf.js';
import {
  EmployeeMetrics,
  formatCurrency,
  formatHours,
  formatPercentage,
} from './employeeReports';

// Export employee reports to Excel
export async function exportEmployeeReportsToExcel(
  employees: EmployeeMetrics[],
  totals: { totalHours: number; billableHours: number; totalRevenue: number; totalCost: number; netProfit: number; serviceTicketCount: number },
  periodLabel: string,
  filename: string = 'employee-reports'
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'IONEX Time Tracking';
  workbook.created = new Date();

  // Summary Sheet
  const summarySheet = workbook.addWorksheet('Summary');
  
  // Title
  summarySheet.mergeCells('A1:H1');
  summarySheet.getCell('A1').value = `Employee Reports - ${periodLabel}`;
  summarySheet.getCell('A1').font = { bold: true, size: 16 };
  summarySheet.getCell('A1').alignment = { horizontal: 'center' };

  // Generated date
  summarySheet.mergeCells('A2:H2');
  summarySheet.getCell('A2').value = `Generated: ${new Date().toLocaleDateString()}`;
  summarySheet.getCell('A2').alignment = { horizontal: 'center' };
  summarySheet.getCell('A2').font = { italic: true, size: 10 };

  // Summary totals
  summarySheet.getCell('A4').value = 'Summary';
  summarySheet.getCell('A4').font = { bold: true, size: 12 };

  summarySheet.getCell('A5').value = 'Total Hours:';
  summarySheet.getCell('B5').value = totals.totalHours;
  summarySheet.getCell('B5').numFmt = '0.00';

  summarySheet.getCell('A6').value = 'Billable Hours:';
  summarySheet.getCell('B6').value = totals.billableHours;
  summarySheet.getCell('B6').numFmt = '0.00';

  summarySheet.getCell('A7').value = 'Total Revenue:';
  summarySheet.getCell('B7').value = totals.totalRevenue;
  summarySheet.getCell('B7').numFmt = '"$"#,##0.00';

  summarySheet.getCell('A8').value = 'Total Cost:';
  summarySheet.getCell('B8').value = totals.totalCost;
  summarySheet.getCell('B8').numFmt = '"$"#,##0.00';

  summarySheet.getCell('A9').value = 'Net Profit:';
  summarySheet.getCell('B9').value = totals.netProfit;
  summarySheet.getCell('B9').numFmt = '"$"#,##0.00';

  summarySheet.getCell('A10').value = 'Profit Margin:';
  summarySheet.getCell('B10').value = totals.totalRevenue > 0 ? (totals.netProfit / totals.totalRevenue) * 100 : 0;
  summarySheet.getCell('B10').numFmt = '0.00%';

  summarySheet.getCell('A11').value = 'Service Tickets:';
  summarySheet.getCell('B11').value = totals.serviceTicketCount;

  summarySheet.getCell('A12').value = 'Avg Billable %:';
  summarySheet.getCell('B12').value = totals.totalHours > 0 
    ? (totals.billableHours / totals.totalHours) * 100 
    : 0;
  summarySheet.getCell('B12').numFmt = '0.0"%';

  // Employee details header (row 13)
  const headerRow = 13;
  const headers = ['Employee', 'Position', 'Total Hours', 'Billable Hours', 'Non-Billable', 'Billable %', 'Revenue', 'Cost', 'Net Profit', 'Profit Margin', 'Avg Rate', 'Tickets'];
  headers.forEach((header, index) => {
    const cell = summarySheet.getCell(headerRow, index + 1);
    cell.value = header;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center' };
    cell.border = {
      top: { style: 'thin' },
      bottom: { style: 'thin' },
      left: { style: 'thin' },
      right: { style: 'thin' },
    };
  });

  // Employee data rows
  employees.forEach((emp, index) => {
    const rowNum = headerRow + 1 + index;
    summarySheet.getCell(rowNum, 1).value = emp.employeeName;
    summarySheet.getCell(rowNum, 2).value = emp.position || '-';
    summarySheet.getCell(rowNum, 3).value = emp.totalHours;
    summarySheet.getCell(rowNum, 3).numFmt = '0.00';
    summarySheet.getCell(rowNum, 4).value = emp.billableHours;
    summarySheet.getCell(rowNum, 4).numFmt = '0.00';
    summarySheet.getCell(rowNum, 5).value = emp.nonBillableHours;
    summarySheet.getCell(rowNum, 5).numFmt = '0.00';
    summarySheet.getCell(rowNum, 6).value = emp.efficiency / 100;
    summarySheet.getCell(rowNum, 6).numFmt = '0.0%';
    summarySheet.getCell(rowNum, 7).value = emp.totalRevenue;
    summarySheet.getCell(rowNum, 7).numFmt = '"$"#,##0.00';
    summarySheet.getCell(rowNum, 8).value = emp.totalCost;
    summarySheet.getCell(rowNum, 8).numFmt = '"$"#,##0.00';
    summarySheet.getCell(rowNum, 9).value = emp.netProfit;
    summarySheet.getCell(rowNum, 9).numFmt = '"$"#,##0.00';
    summarySheet.getCell(rowNum, 10).value = emp.profitMargin / 100;
    summarySheet.getCell(rowNum, 10).numFmt = '0.00%';
    summarySheet.getCell(rowNum, 11).value = emp.averageRate;
    summarySheet.getCell(rowNum, 11).numFmt = '"$"#,##0.00';
    summarySheet.getCell(rowNum, 12).value = emp.serviceTicketCount;

    // Add borders
    for (let col = 1; col <= 12; col++) {
      summarySheet.getCell(rowNum, col).border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      };
    }
  });

  // Auto-fit columns
  summarySheet.columns.forEach((column, index) => {
    let maxLength = headers[index]?.length || 10;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const cellValue = cell.value?.toString() || '';
      maxLength = Math.max(maxLength, cellValue.length);
    });
    column.width = Math.min(maxLength + 2, 30);
  });

  // Rate Type Breakdown Sheet
  const rateTypeSheet = workbook.addWorksheet('Rate Type Breakdown');
  
  rateTypeSheet.mergeCells('A1:G1');
  rateTypeSheet.getCell('A1').value = 'Hours by Rate Type';
  rateTypeSheet.getCell('A1').font = { bold: true, size: 14 };

  const rateTypeHeaders = ['Employee', 'Shop Time', 'Field Time', 'Travel Time', 'Shop OT', 'Field OT', 'Total'];
  rateTypeHeaders.forEach((header, index) => {
    const cell = rateTypeSheet.getCell(3, index + 1);
    cell.value = header;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });

  employees.forEach((emp, index) => {
    const rowNum = 4 + index;
    rateTypeSheet.getCell(rowNum, 1).value = emp.employeeName;
    rateTypeSheet.getCell(rowNum, 2).value = emp.rateTypeBreakdown.shopTime.hours;
    rateTypeSheet.getCell(rowNum, 2).numFmt = '0.00';
    rateTypeSheet.getCell(rowNum, 3).value = emp.rateTypeBreakdown.fieldTime.hours;
    rateTypeSheet.getCell(rowNum, 3).numFmt = '0.00';
    rateTypeSheet.getCell(rowNum, 4).value = emp.rateTypeBreakdown.travelTime.hours;
    rateTypeSheet.getCell(rowNum, 4).numFmt = '0.00';
    rateTypeSheet.getCell(rowNum, 5).value = emp.rateTypeBreakdown.shopOvertime.hours;
    rateTypeSheet.getCell(rowNum, 5).numFmt = '0.00';
    rateTypeSheet.getCell(rowNum, 6).value = emp.rateTypeBreakdown.fieldOvertime.hours;
    rateTypeSheet.getCell(rowNum, 6).numFmt = '0.00';
    rateTypeSheet.getCell(rowNum, 7).value = emp.totalHours;
    rateTypeSheet.getCell(rowNum, 7).numFmt = '0.00';
  });

  rateTypeSheet.columns.forEach((column) => {
    column.width = 15;
  });
  rateTypeSheet.getColumn(1).width = 25;

  // Project Breakdown Sheet
  const projectSheet = workbook.addWorksheet('Project Breakdown');
  
  projectSheet.mergeCells('A1:D1');
  projectSheet.getCell('A1').value = 'Hours by Project';
  projectSheet.getCell('A1').font = { bold: true, size: 14 };

  const projectHeaders = ['Employee', 'Project', 'Hours', 'Revenue'];
  projectHeaders.forEach((header, index) => {
    const cell = projectSheet.getCell(3, index + 1);
    cell.value = header;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });

  let projectRowNum = 4;
  employees.forEach((emp) => {
    emp.projectBreakdown.forEach((proj) => {
      projectSheet.getCell(projectRowNum, 1).value = emp.employeeName;
      projectSheet.getCell(projectRowNum, 2).value = proj.projectName;
      projectSheet.getCell(projectRowNum, 3).value = proj.hours;
      projectSheet.getCell(projectRowNum, 3).numFmt = '0.00';
      projectSheet.getCell(projectRowNum, 4).value = proj.revenue;
      projectSheet.getCell(projectRowNum, 4).numFmt = '"$"#,##0.00';
      projectRowNum++;
    });
  });

  projectSheet.columns.forEach((column) => {
    column.width = 20;
  });

  // Customer Breakdown Sheet
  const customerSheet = workbook.addWorksheet('Customer Breakdown');
  
  customerSheet.mergeCells('A1:D1');
  customerSheet.getCell('A1').value = 'Hours by Customer';
  customerSheet.getCell('A1').font = { bold: true, size: 14 };

  const customerHeaders = ['Employee', 'Customer', 'Hours', 'Revenue'];
  customerHeaders.forEach((header, index) => {
    const cell = customerSheet.getCell(3, index + 1);
    cell.value = header;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });

  let customerRowNum = 4;
  employees.forEach((emp) => {
    emp.customerBreakdown.forEach((cust) => {
      customerSheet.getCell(customerRowNum, 1).value = emp.employeeName;
      customerSheet.getCell(customerRowNum, 2).value = cust.customerName;
      customerSheet.getCell(customerRowNum, 3).value = cust.hours;
      customerSheet.getCell(customerRowNum, 3).numFmt = '0.00';
      customerSheet.getCell(customerRowNum, 4).value = cust.revenue;
      customerSheet.getCell(customerRowNum, 4).numFmt = '"$"#,##0.00';
      customerRowNum++;
    });
  });

  customerSheet.columns.forEach((column) => {
    column.width = 20;
  });

  // Download the file
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Export employee reports to PDF
export async function exportEmployeeReportsToPDF(
  employees: EmployeeMetrics[],
  totals: { totalHours: number; billableHours: number; totalRevenue: number; totalCost: number; netProfit: number; serviceTicketCount: number },
  periodLabel: string,
  filename: string = 'employee-reports'
): Promise<void> {
  // Create HTML content for PDF
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          font-family: Arial, sans-serif;
          font-size: 11px;
          color: #333;
          padding: 20px;
        }
        h1 {
          font-size: 18px;
          margin-bottom: 5px;
        }
        h2 {
          font-size: 14px;
          margin-top: 20px;
          margin-bottom: 10px;
          border-bottom: 1px solid #ccc;
          padding-bottom: 5px;
        }
        .subtitle {
          font-size: 10px;
          color: #666;
          margin-bottom: 20px;
        }
        .summary-grid {
          display: flex;
          gap: 20px;
          margin-bottom: 20px;
        }
        .summary-item {
          background: #f5f5f5;
          padding: 10px 15px;
          border-radius: 4px;
        }
        .summary-label {
          font-size: 9px;
          color: #666;
          text-transform: uppercase;
        }
        .summary-value {
          font-size: 16px;
          font-weight: bold;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 20px;
        }
        th, td {
          border: 1px solid #ddd;
          padding: 6px 8px;
          text-align: left;
        }
        th {
          background: #4472C4;
          color: white;
          font-size: 10px;
        }
        tr:nth-child(even) {
          background: #f9f9f9;
        }
        .text-right {
          text-align: right;
        }
        .text-center {
          text-align: center;
        }
        .efficiency-high { color: #28a745; }
        .efficiency-medium { color: #ffc107; }
        .efficiency-low { color: #dc3545; }
        .page-break {
          page-break-before: always;
        }
      </style>
    </head>
    <body>
      <h1>Employee Reports</h1>
      <div class="subtitle">Period: ${periodLabel} | Generated: ${new Date().toLocaleDateString()}</div>

      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-label">Total Hours</div>
          <div class="summary-value">${formatHours(totals.totalHours)}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Billable Hours</div>
          <div class="summary-value">${formatHours(totals.billableHours)}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Revenue</div>
          <div class="summary-value">${formatCurrency(totals.totalRevenue)}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Tickets</div>
          <div class="summary-value">${totals.serviceTicketCount}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Billable %</div>
          <div class="summary-value">${totals.totalHours > 0 ? formatPercentage((totals.billableHours / totals.totalHours) * 100) : '0%'}</div>
        </div>
      </div>

      <h2>Employee Summary</h2>
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Position</th>
            <th class="text-right">Total Hours</th>
            <th class="text-right">Billable</th>
            <th class="text-center">Billable %</th>
            <th class="text-right">Revenue</th>
            <th class="text-right">Avg Rate</th>
            <th class="text-right">Tickets</th>
          </tr>
        </thead>
        <tbody>
          ${employees.map(emp => `
            <tr>
              <td>${emp.employeeName}</td>
              <td>${emp.position || '-'}</td>
              <td class="text-right">${formatHours(emp.totalHours)}</td>
              <td class="text-right">${formatHours(emp.billableHours)}</td>
              <td class="text-center ${emp.efficiency >= 80 ? 'efficiency-high' : emp.efficiency >= 60 ? 'efficiency-medium' : 'efficiency-low'}">
                ${formatPercentage(emp.efficiency)}
              </td>
              <td class="text-right">${formatCurrency(emp.totalRevenue)}</td>
              <td class="text-right">${formatCurrency(emp.averageRate)}</td>
              <td class="text-right">${emp.serviceTicketCount}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <h2>Hours by Rate Type</h2>
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th class="text-right">Shop Time</th>
            <th class="text-right">Field Time</th>
            <th class="text-right">Travel Time</th>
            <th class="text-right">Shop OT</th>
            <th class="text-right">Field OT</th>
            <th class="text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          ${employees.map(emp => `
            <tr>
              <td>${emp.employeeName}</td>
              <td class="text-right">${formatHours(emp.rateTypeBreakdown.shopTime.hours)}</td>
              <td class="text-right">${formatHours(emp.rateTypeBreakdown.fieldTime.hours)}</td>
              <td class="text-right">${formatHours(emp.rateTypeBreakdown.travelTime.hours)}</td>
              <td class="text-right">${formatHours(emp.rateTypeBreakdown.shopOvertime.hours)}</td>
              <td class="text-right">${formatHours(emp.rateTypeBreakdown.fieldOvertime.hours)}</td>
              <td class="text-right">${formatHours(emp.totalHours)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </body>
    </html>
  `;

  // Generate PDF
  const element = document.createElement('div');
  element.innerHTML = html;
  document.body.appendChild(element);

  const opt = {
    margin: 10,
    filename: `${filename}.pdf`,
    image: { type: 'jpeg' as const, quality: 0.98 },
    html2canvas: { scale: 3, useCORS: true },
    jsPDF: { unit: 'mm' as const, format: 'a4' as const, orientation: 'landscape' as const },
  };

  await html2pdf().set(opt).from(element).save();
  document.body.removeChild(element);
}

