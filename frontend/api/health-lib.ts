/**
 * Diagnostic: does importing my _lib modules crash? Doesn't call any handler logic.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const result: Record<string, unknown> = { success: true, imports: {} as Record<string, string> };
  try {
    const auth = await import('./_lib/auth');
    (result.imports as Record<string, string>).auth = Object.keys(auth).join(',');
  } catch (err: any) {
    return res.status(500).json({ stage: 'import auth', error: err?.message, stack: err?.stack });
  }
  try {
    const qbo = await import('./_lib/quickbooks');
    (result.imports as Record<string, string>).quickbooks = Object.keys(qbo).join(',');
  } catch (err: any) {
    return res.status(500).json({ stage: 'import quickbooks', error: err?.message, stack: err?.stack });
  }
  res.status(200).json(result);
}
