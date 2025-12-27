-- Create development user for testing
-- Run this in your Supabase SQL Editor

-- Insert dev user (bypassing RLS)
INSERT INTO public.users (id, email, first_name, last_name, role)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'admin@ionexsystems.com',
  'Admin',
  'User',
  'ADMIN'
)
ON CONFLICT (id) DO NOTHING;

-- Add temporary policy to allow unauthenticated writes (for dev mode)
-- WARNING: Remove this policy in production!
DROP POLICY IF EXISTS "Allow dev mode inserts" ON public.time_entries;
CREATE POLICY "Allow dev mode inserts" ON public.time_entries 
  FOR INSERT 
  WITH CHECK (user_id = '00000000-0000-0000-0000-000000000001');

DROP POLICY IF EXISTS "Allow dev mode selects" ON public.time_entries;
CREATE POLICY "Allow dev mode selects" ON public.time_entries 
  FOR SELECT 
  USING (user_id = '00000000-0000-0000-0000-000000000001' OR true);

DROP POLICY IF EXISTS "Allow dev mode updates" ON public.time_entries;
CREATE POLICY "Allow dev mode updates" ON public.time_entries 
  FOR UPDATE 
  USING (user_id = '00000000-0000-0000-0000-000000000001');

DROP POLICY IF EXISTS "Allow dev mode deletes" ON public.time_entries;
CREATE POLICY "Allow dev mode deletes" ON public.time_entries 
  FOR DELETE 
  USING (user_id = '00000000-0000-0000-0000-000000000001');

-- Verify the user was created
SELECT id, email, first_name, last_name, role FROM public.users WHERE id = '00000000-0000-0000-0000-000000000001';






