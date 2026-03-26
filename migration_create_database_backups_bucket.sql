-- Create storage bucket for database backups (online copy)
-- Private bucket: only service_role can read/write. Used by backup scripts.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('database-backups', 'database-backups', false, 524288000, ARRAY['application/sql', 'application/octet-stream', 'text/plain'])
ON CONFLICT (id) DO NOTHING;
