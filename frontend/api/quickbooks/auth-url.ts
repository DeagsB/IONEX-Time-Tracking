import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireRole } from '../_lib/auth.js';
import { getAuthorizationUrl } from '../_lib/quickbooks.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const user = await requireRole(req, res, ['ADMIN', 'DEVELOPER']);
  if (!user) return;
  try {
    const state = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const authUrl = getAuthorizationUrl(state);
    res.json({ success: true, authUrl, state });
  } catch (error: any) {
    console.error('[QBO] auth-url error:', error);
    res.status(500).json({ success: false, error: error?.message ?? 'Unknown error' });
  }
}
