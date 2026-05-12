import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireRole } from '../_lib/auth.js';
import { isConnected } from '../_lib/quickbooks.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const user = await requireRole(req, res, ['ADMIN', 'DEVELOPER']);
  if (!user) return;
  try {
    const connected = await isConnected();
    res.json({ success: true, connected });
  } catch (error: any) {
    console.error('[QBO] status error:', error);
    res.status(500).json({ success: false, error: error?.message ?? 'Unknown error' });
  }
}
