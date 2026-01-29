-- Create storage bucket for service ticket PDFs
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('service-ticket-pdfs', 'service-ticket-pdfs', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Authenticated users can upload PDFs" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read PDFs" ON storage.objects;
DROP POLICY IF EXISTS "Service role full access on pdfs" ON storage.objects;

-- Allow authenticated users to upload PDFs
CREATE POLICY "Authenticated users can upload PDFs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'service-ticket-pdfs');

-- Allow authenticated users to read PDFs
CREATE POLICY "Authenticated users can read PDFs" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'service-ticket-pdfs');

-- Allow service role full access
CREATE POLICY "Service role full access on pdfs" ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'service-ticket-pdfs');
