/**
 * Diagnostic: does just importing @supabase/supabase-js break Vercel functions?
 * Doesn't call any Supabase method — only imports + creates a client with the real env values.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_KEY || '';
    const client = createClient(url, key);
    res.status(200).json({
      success: true,
      message: 'Supabase client constructed without throwing',
      hasClient: !!client,
      urlLength: url.length,
      keyLength: key.length,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      stage: 'createClient',
      error: err?.message ?? String(err),
      stack: err?.stack ?? null,
    });
  }
}
