import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireRole } from '../../../_lib/auth';
import { attachFileToInvoice } from '../../../_lib/quickbooks';

export const config = {
  api: {
    bodyParser: { sizeLimit: '50mb' },
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
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
    const { pdfBase64, fileName } = req.body ?? {};
    if (!pdfBase64 || !fileName) {
      return res.status(400).json({ success: false, error: 'Missing required fields: pdfBase64, fileName' });
    }
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    await attachFileToInvoice(invoiceId, pdfBuffer, fileName);
    res.json({ success: true, message: 'PDF attached successfully' });
  } catch (error: any) {
    console.error('[QBO] invoice/:id/attach error:', error);
    res.status(500).json({ success: false, error: error?.message ?? 'Unknown error' });
  }
}
