import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireRole } from '../_lib/auth.js';
import { disconnect } from '../_lib/quickbooks.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const user = await requireRole(req, res, ['ADMIN', 'DEVELOPER']);
  if (!user) return;
  try {
    await disconnect();
    res.json({ success: true, message: 'QuickBooks disconnected successfully' });
  } catch (error: any) {
    console.error('[QBO] disconnect error:', error);
    res.status(500).json({ success: false, error: error?.message ?? 'Unknown error' });
  }
}
