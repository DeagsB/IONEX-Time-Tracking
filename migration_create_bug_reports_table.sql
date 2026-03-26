-- Migration: Create bug_reports table for storing user bug reports
CREATE TABLE IF NOT EXISTS public.bug_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  user_email TEXT,
  user_name TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  notes TEXT
);

-- Create index for user_id
CREATE INDEX IF NOT EXISTS idx_bug_reports_user_id ON public.bug_reports(user_id);

-- Create index for status
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON public.bug_reports(status);

-- Create index for created_at
CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at ON public.bug_reports(created_at);

-- Add updated_at trigger
CREATE TRIGGER update_bug_reports_updated_at 
  BEFORE UPDATE ON public.bug_reports 
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS
ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can create bug reports
CREATE POLICY "Users can create bug reports" ON public.bug_reports
  FOR INSERT
  WITH CHECK (true);

-- Users can read their own bug reports
CREATE POLICY "Users can read own bug reports" ON public.bug_reports
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- Admins can read all bug reports
CREATE POLICY "Admins can read all bug reports" ON public.bug_reports
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users 
      WHERE id = (SELECT auth.uid()) 
      AND role = 'ADMIN'
    )
  );

-- Admins can update all bug reports
CREATE POLICY "Admins can update all bug reports" ON public.bug_reports
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users 
      WHERE id = (SELECT auth.uid()) 
      AND role = 'ADMIN'
    )
  );

COMMENT ON TABLE public.bug_reports IS 'Stores bug reports and issues submitted by users';
COMMENT ON COLUMN public.bug_reports.user_id IS 'ID of the user who reported the bug (can be NULL for anonymous reports)';
COMMENT ON COLUMN public.bug_reports.status IS 'Current status of the bug report: open, in_progress, resolved, closed';
COMMENT ON COLUMN public.bug_reports.priority IS 'Priority level: low, medium, high, critical';

