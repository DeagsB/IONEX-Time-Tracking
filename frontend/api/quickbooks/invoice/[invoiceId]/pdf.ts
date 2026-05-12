import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireRole } from '../../../_lib/auth';
import { downloadInvoicePdf } from '../../../_lib/quickbooks';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const user = await requireRole(req, res, ['ADMIN', 'DEVELOPER']);
  if (!user) return;
  try {
    const invoiceIdParam = req.query.invoiceId;
    const invoiceId = Array.isArray(invoiceIdParam) ? invoiceIdParam[0] : invoiceIdParam;
    if (!invoiceId) {
      return res.status(400).json({ success: false, error: 'Missing invoiceId in path' });
    }
    const pdfBuffer = await downloadInvoicePdf(invoiceId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="qbo-invoice-${invoiceId}.pdf"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.status(200).send(pdfBuffer);
  } catch (error: any) {
    console.error('[QBO] invoice/:id/pdf error:', error);
    res.status(500).json({ success: false, error: error?.message ?? 'Unknown error' });
  }
}
