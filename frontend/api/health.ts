/**
 * Dead-simple health check. No imports beyond @vercel/node types so it can't crash on module
 * load. If this returns JSON, the Vercel API routing layer is working — and the QBO routes
 * are crashing because of their imports, not because of Vercel.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    success: true,
    message: 'API alive',
    env: {
      hasSupabaseUrl: !!process.env.SUPABASE_URL,
      hasSupabaseServiceKey: !!process.env.SUPABASE_SERVICE_KEY,
      hasQboClientId: !!process.env.QBO_CLIENT_ID,
      hasQboClientSecret: !!process.env.QBO_CLIENT_SECRET,
      hasQboRedirectUri: !!process.env.QBO_REDIRECT_URI,
      qboEnvironment: process.env.QBO_ENVIRONMENT || '(unset)',
      hasFrontendUrl: !!process.env.FRONTEND_URL,
    },
  });
}
