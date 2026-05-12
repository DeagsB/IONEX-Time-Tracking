/**
 * Vercel API route auth helper. Mirrors backend/src/middleware/auth.ts:
 *   - accepts a Supabase access token in `Authorization: Bearer …`
 *   - looks up the `users` row for role + global_admin
 *   - returns { id, email, role } or null
 *
 * Usage in a route handler:
 *
 *   const user = await requireRole(req, res, ['ADMIN', 'DEVELOPER']);
 *   if (!user) return;          // helper already sent 401/403
 *   // proceed with user
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

type AppRole = 'ADMIN' | 'DEVELOPER' | 'USER';

export interface AuthedUser {
  id: string;
  email: string;
  role: AppRole;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are not set on the Vercel project.');
  return createClient(url, key);
}

export async function authenticate(req: VercelRequest): Promise<AuthedUser | null> {
  const authHeader = req.headers['authorization'] || req.headers['Authorization' as keyof typeof req.headers];
  const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const token = (headerValue || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    const { data: profile } = await supabase
      .from('users')
      .select('role, global_admin')
      .eq('id', user.id)
      .single();
    let role: AppRole = (profile?.role as AppRole) || 'USER';
    if (profile?.global_admin) role = 'ADMIN';
    if (role !== 'ADMIN' && role !== 'DEVELOPER') role = 'USER';
    return { id: user.id, email: user.email ?? '', role };
  } catch (err) {
    console.error('[auth] authenticate failed:', err);
    return null;
  }
}

/** Convenience: enforce auth + role in one call. Returns the user, or null after sending 401/403. */
export async function requireRole(
  req: VercelRequest,
  res: VercelResponse,
  allowedRoles: AppRole[]
): Promise<AuthedUser | null> {
  const user = await authenticate(req);
  if (!user) {
    res.status(401).json({ success: false, error: 'No token, authorization denied' });
    return null;
  }
  if (!allowedRoles.includes(user.role)) {
    res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions' });
    return null;
  }
  return user;
}
