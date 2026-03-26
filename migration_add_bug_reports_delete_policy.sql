-- Migration: Add DELETE policy for bug_reports table
-- Admins should be able to delete bug reports and suggestions

-- Admins can delete all bug reports
CREATE POLICY "Admins can delete all bug reports" ON public.bug_reports
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.users 
      WHERE id = (SELECT auth.uid()) 
      AND role = 'ADMIN'
    )
  );

COMMENT ON POLICY "Admins can delete all bug reports" ON public.bug_reports IS 'Allows admins to delete bug reports and suggestions';
