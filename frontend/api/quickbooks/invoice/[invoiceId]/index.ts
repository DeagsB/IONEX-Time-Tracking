import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireRole } from '../../../_lib/auth';
import { getInvoice } from '../../../_lib/quickbooks';

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
    const invoice = await getInvoice(invoiceId);
    res.json({ success: true, invoice });
  } catch (error: any) {
    console.error('[QBO] invoice/:id error:', error);
    res.status(500).json({ success: false, error: error?.message ?? 'Unknown error' });
  }
}
