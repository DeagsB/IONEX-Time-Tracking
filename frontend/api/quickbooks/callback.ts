import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exchangeCodeForTokens } from '../_lib/quickbooks.js';

/**
 * QBO OAuth callback. Intuit redirects the browser here with ?code=&realmId=&state= after the
 * user authorises. We exchange the code for tokens, store them, and redirect back to the frontend.
 *
 * FRONTEND_URL env var should point at the public site (e.g. https://your-app.vercel.app). If
 * unset we fall back to the request's own origin so preview deployments still work.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const origin = process.env.FRONTEND_URL
    || `${(req.headers['x-forwarded-proto'] as string | undefined) ?? 'https'}://${req.headers.host ?? 'localhost'}`;
  const { code, realmId, error } = req.query;
  try {
    if (error) {
      return res.redirect(302, `${origin}/profile?qbo=error&message=${encodeURIComponent(String(error))}`);
    }
    if (!code || !realmId) {
      return res.redirect(302, `${origin}/profile?qbo=error&message=Missing+required+parameters`);
    }
    await exchangeCodeForTokens(String(code), String(realmId));
    res.redirect(302, `${origin}/profile?qbo=success`);
  } catch (err: any) {
    console.error('[QBO] callback error:', err);
    res.redirect(302, `${origin}/profile?qbo=error&message=${encodeURIComponent(err?.message ?? 'Unknown error')}`);
  }
}
