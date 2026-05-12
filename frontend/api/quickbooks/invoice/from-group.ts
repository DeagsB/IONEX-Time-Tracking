import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireRole } from '../../_lib/auth';
import { createInvoiceFromGroup } from '../../_lib/quickbooks';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const user = await requireRole(req, res, ['ADMIN', 'DEVELOPER']);
  if (!user) return;
  try {
    const { customerName, customerEmail, customerPo, reference, poAfeLineItems, date, docNumber } = req.body ?? {};
    if (!customerName || !poAfeLineItems || !Array.isArray(poAfeLineItems) || !date) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: customerName, poAfeLineItems (array), date',
      });
    }
    const result = await createInvoiceFromGroup({
      customerName,
      customerEmail,
      customerPo,
      reference,
      poAfeLineItems,
      date,
      docNumber,
    });
    res.json({ success: true, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber });
  } catch (error: any) {
    console.error('[QBO] invoice/from-group error:', error);
    res.status(500).json({ success: false, error: error?.message ?? 'Unknown error' });
  }
}
