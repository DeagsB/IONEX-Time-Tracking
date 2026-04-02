import * as pdfjs from 'pdfjs-dist';

// Vite resolves this to a static URL for the PDF.js worker thread
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type ReceiptAutoFillResult = {
  /** Receipt subtotal before tax (best guess) */
  amount: string;
  gst: string;
  expenseDate: string;
  hint?: string;
  method: 'pdf-text' | 'ocr' | 'none';
};

function fmtMoney(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function parseLooseMoney(s: string): number | null {
  const t = s.replace(/,/g, '').trim();
  const m = t.match(/^(\d+(?:\.\d{1,2})?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0 || n > 999_999) return null;
  return Math.round(n * 100) / 100;
}

/** Pull dollar-like values from a line (e.g. $1,234.56 or 1234.56) */
function moneyValuesOnLine(line: string): number[] {
  const out: number[] = [];
  const re = /\$?\s*([\d,]+\.\d{2})\b|\$?\s*([\d,]+\.\d{1})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const raw = (m[1] || m[2] || '').replace(/,/g, '');
    const n = parseLooseMoney(raw);
    if (n != null) out.push(n);
  }
  return out;
}

function parseExpenseDateIso(raw: string): string {
  const iso = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = raw.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/);
  if (slash) {
    const a = parseInt(slash[1], 10);
    const b = parseInt(slash[2], 10);
    const y = slash[3];
    let mm: string;
    let dd: string;
    if (a > 12) {
      dd = String(a).padStart(2, '0');
      mm = String(b).padStart(2, '0');
    } else if (b > 12) {
      mm = String(a).padStart(2, '0');
      dd = String(b).padStart(2, '0');
    } else {
      mm = String(a).padStart(2, '0');
      dd = String(b).padStart(2, '0');
    }
    return `${y}-${mm}-${dd}`;
  }
  return '';
}

/**
 * Heuristic parse for Canadian-style receipts (GST/HST/PST lines, subtotal, total).
 * OCR noise means values should always be verified by the user.
 */
export function parseReceiptText(raw: string): Omit<ReceiptAutoFillResult, 'method'> {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);

  const expenseDate = parseExpenseDateIso(raw);

  let gstVal: number | null = null;
  const taxLine =
    /(gst|hst|pst|qst|goods\s+and\s+services|sales\s+tax|vat\b)/i;
  for (const line of lines) {
    if (/phone|fax|gst\s*#|hst\s*#|business\s*#|registration|www\.|@/i.test(line)) continue;
    if (!taxLine.test(line)) continue;
    const nums = moneyValuesOnLine(line);
    const pick = nums.filter((n) => n < 50_000);
    if (pick.length > 0) {
      gstVal = pick[pick.length - 1];
      break;
    }
  }

  let subtotal: number | null = null;
  const subKw =
    /(subtotal|sub-total|sub\s+total|room\s*total|charges|amount\s*before\s*tax|net\s*amount|balance\s*forward)/i;
  for (const line of lines) {
    if (!subKw.test(line)) continue;
    const nums = moneyValuesOnLine(line);
    const pick = nums.filter((n) => n > 0 && n < 500_000);
    if (pick.length > 0) {
      subtotal = pick[pick.length - 1];
      break;
    }
  }

  let total: number | null = null;
  const totalKw =
    /(grand\s*total|invoice\s*total|total\s*due|amount\s*due|balance\s*due|total\s*payable|^\s*total\s*[:.\s])/i;
  const bottomStart = Math.max(0, Math.floor(lines.length * 0.35));
  for (let i = lines.length - 1; i >= bottomStart; i--) {
    const line = lines[i];
    if (/subtotal|summary\s*of\s*charges/i.test(line) && !totalKw.test(line)) continue;
    if (!totalKw.test(line) && !/(^|\s)total(\s|$)/i.test(line)) continue;
    const nums = moneyValuesOnLine(line);
    const pick = nums.filter((n) => n > 0 && n < 500_000);
    if (pick.length > 0) {
      total = pick[pick.length - 1];
      break;
    }
  }

  let amountStr = '';
  let gstStr = '';
  if (subtotal != null && gstVal != null) {
    amountStr = fmtMoney(subtotal);
    gstStr = fmtMoney(gstVal);
  } else if (total != null && gstVal != null && total + 0.005 >= gstVal) {
    amountStr = fmtMoney(Math.max(0, total - gstVal));
    gstStr = fmtMoney(gstVal);
  } else if (total != null) {
    amountStr = fmtMoney(total);
    if (gstVal != null) gstStr = fmtMoney(gstVal);
  } else if (subtotal != null) {
    amountStr = fmtMoney(subtotal);
    if (gstVal != null) gstStr = fmtMoney(gstVal);
  }

  const hint =
    amountStr || gstStr || expenseDate
      ? 'Values were read automatically — please verify against the receipt.'
      : undefined;

  return { amount: amountStr, gst: gstStr, expenseDate, hint };
}

async function extractPdfText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buf) });
  const pdf = await loadingTask.promise;
  const maxPages = Math.min(pdf.numPages, 5);
  let text = '';
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const pageText = tc.items.map((item) => ('str' in item ? (item as { str: string }).str : '')).join(' ');
    text += `${pageText}\n`;
  }
  return text;
}

async function extractImageTextOcr(file: File): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  try {
    const url = URL.createObjectURL(file);
    try {
      const {
        data: { text },
      } = await worker.recognize(url);
      return text || '';
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    await worker.terminate();
  }
}

/**
 * Read a receipt image or PDF in the browser and guess subtotal, GST, and date.
 * PDFs use embedded text when available; photos use OCR (slower, first run downloads language data).
 */
export async function extractReceiptAutoFill(file: File): Promise<ReceiptAutoFillResult> {
  const defaultDate = new Date().toISOString().split('T')[0];
  let method: ReceiptAutoFillResult['method'] = 'none';
  let text = '';

  try {
    if (file.type === 'application/pdf') {
      text = await extractPdfText(file);
      method = text.replace(/\s/g, '').length > 40 ? 'pdf-text' : 'none';
    } else if (file.type.startsWith('image/')) {
      text = await extractImageTextOcr(file);
      method = text.replace(/\s/g, '').length > 12 ? 'ocr' : 'none';
    } else {
      return { amount: '', gst: '', expenseDate: defaultDate, method: 'none' };
    }
  } catch {
    return {
      amount: '',
      gst: '',
      expenseDate: defaultDate,
      method: 'none',
      hint: 'Could not read this file automatically. Enter amounts manually.',
    };
  }

  const parsed = parseReceiptText(text);
  return {
    amount: parsed.amount,
    gst: parsed.gst,
    /** Empty when no date was found in the document (caller should keep existing field). */
    expenseDate: parsed.expenseDate,
    hint: parsed.hint,
    method,
  };
}
