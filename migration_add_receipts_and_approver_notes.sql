-- Migration: Add receipts and approver notes (employee expenses feature)
-- Run in Supabase SQL Editor.

-- 1. Add approver_notes to service_tickets tables
ALTER TABLE public.service_tickets
  ADD COLUMN IF NOT EXISTS approver_notes TEXT;

ALTER TABLE public.service_tickets_demo
  ADD COLUMN IF NOT EXISTS approver_notes TEXT;

COMMENT ON COLUMN public.service_tickets.approver_notes IS 'Internal notes for the approver of the service ticket.';
COMMENT ON COLUMN public.service_tickets_demo.approver_notes IS 'Internal notes for the approver of the service ticket.';

-- 2. Create user_expenses table
CREATE TABLE IF NOT EXISTS public.user_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  service_ticket_id UUID REFERENCES public.service_tickets(id) ON DELETE SET NULL,
  amount DECIMAL(10, 2) NOT NULL,
  description TEXT NOT NULL,
  receipt_url TEXT,
  expense_date DATE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TRIGGER update_user_expenses_updated_at
  BEFORE UPDATE ON public.user_expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.user_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own expenses" ON public.user_expenses
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can insert own expenses" ON public.user_expenses
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own expenses" ON public.user_expenses
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own expenses" ON public.user_expenses
  FOR DELETE USING (user_id = auth.uid());

CREATE POLICY "Admins and Developers can manage all expenses" ON public.user_expenses
  FOR ALL USING (public.is_admin());

-- 3. Create receipts storage bucket (if not exists)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'receipts',
  'receipts',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- 4. Storage RLS policies for receipts bucket
DROP POLICY IF EXISTS "Users can upload their own receipts" ON storage.objects;
CREATE POLICY "Users can upload their own receipts" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'receipts' AND auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Users can update their own receipts" ON storage.objects;
CREATE POLICY "Users can update their own receipts" ON storage.objects
  FOR UPDATE USING (bucket_id = 'receipts' AND (auth.uid() = owner OR (SELECT public.is_admin())));

DROP POLICY IF EXISTS "Users can delete their own receipts" ON storage.objects;
CREATE POLICY "Users can delete their own receipts" ON storage.objects
  FOR DELETE USING (bucket_id = 'receipts' AND (auth.uid() = owner OR (SELECT public.is_admin())));

DROP POLICY IF EXISTS "Users can read their own receipts" ON storage.objects;
CREATE POLICY "Users can read their own receipts" ON storage.objects
  FOR SELECT USING (bucket_id = 'receipts' AND (auth.uid() = owner OR (SELECT public.is_admin())));
