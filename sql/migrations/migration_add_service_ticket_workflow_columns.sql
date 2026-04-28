-- Add workflow tracking columns to service_tickets table
ALTER TABLE service_tickets 
  ADD COLUMN IF NOT EXISTS workflow_status TEXT DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS qbo_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS qbo_invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS pdf_exported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS sent_to_cnrl_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cnrl_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_to_cnrl_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cnrl_notes TEXT;

-- Add workflow tracking columns to service_tickets_demo table
ALTER TABLE service_tickets_demo 
  ADD COLUMN IF NOT EXISTS workflow_status TEXT DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS qbo_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS qbo_invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS pdf_exported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS sent_to_cnrl_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cnrl_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_to_cnrl_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cnrl_notes TEXT;

-- Update existing approved tickets (those with ticket_number) to have 'approved' workflow_status
UPDATE service_tickets SET workflow_status = 'approved' WHERE ticket_number IS NOT NULL AND workflow_status IS NULL;
UPDATE service_tickets_demo SET workflow_status = 'approved' WHERE ticket_number IS NOT NULL AND workflow_status IS NULL;

-- Set draft status for unapproved tickets
UPDATE service_tickets SET workflow_status = 'draft' WHERE ticket_number IS NULL AND workflow_status IS NULL;
UPDATE service_tickets_demo SET workflow_status = 'draft' WHERE ticket_number IS NULL AND workflow_status IS NULL;

-- Add comment describing the workflow statuses
COMMENT ON COLUMN service_tickets.workflow_status IS 'Workflow status: draft, approved, pdf_exported, qbo_created, sent_to_cnrl, cnrl_approved, submitted_to_cnrl';
