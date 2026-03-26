import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

async function authenticateWithSupabase(
  token: string
): Promise<{ id: string; email: string; role: string } | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;

  const { data: profile } = await supabase
    .from('users')
    .select('role, global_admin')
    .eq('id', user.id)
    .single();

  let role = (profile?.role as string) || 'USER';
  if (profile?.global_admin) role = 'ADMIN';
  return {
    id: user.id,
    email: user.email ?? '',
    role: role === 'ADMIN' || role === 'DEVELOPER' ? role : 'USER',
  };
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'No token, authorization denied' });
    }

    // Try custom JWT first
    try {
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'fallback-secret'
      ) as { id: string; email: string; role: string };
      req.user = decoded;
      return next();
    } catch {
      // Fallback: Supabase JWT (used when frontend uses Supabase Auth)
      const supabaseUser = await authenticateWithSupabase(token);
      if (supabaseUser) {
        req.user = supabaseUser;
        return next();
      }
    }

    res.status(401).json({ error: 'Token is not valid' });
  } catch (error) {
    res.status(401).json({ error: 'Token is not valid' });
  }
};

export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    next();
  };
};

