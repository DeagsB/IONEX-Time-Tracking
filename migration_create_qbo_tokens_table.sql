-- Create table for storing QuickBooks Online OAuth tokens
CREATE TABLE IF NOT EXISTS qbo_tokens (
  id TEXT PRIMARY KEY DEFAULT 'primary',
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  realm_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE qbo_tokens ENABLE ROW LEVEL SECURITY;

-- Only allow service role to access (backend only)
CREATE POLICY "Service role only" ON qbo_tokens
  FOR ALL
  USING (auth.role() = 'service_role');

-- Add comment
COMMENT ON TABLE qbo_tokens IS 'Stores QuickBooks Online OAuth2 tokens for API integration';
