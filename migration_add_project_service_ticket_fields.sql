-- Migration: Add Location, Approver/PO/AFE, and Other fields to projects table
-- These fields will auto-populate corresponding service ticket fields

-- Add to main projects table
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS location TEXT,
ADD COLUMN IF NOT EXISTS approver_po_afe TEXT,
ADD COLUMN IF NOT EXISTS other TEXT;

-- Add to demo projects table if it exists
ALTER TABLE projects_demo
ADD COLUMN IF NOT EXISTS location TEXT,
ADD COLUMN IF NOT EXISTS approver_po_afe TEXT,
ADD COLUMN IF NOT EXISTS other TEXT;

-- Add comments to document the fields
COMMENT ON COLUMN projects.location IS 'Service location - auto-populates service ticket location field';
COMMENT ON COLUMN projects.approver_po_afe IS 'Approver/PO/AFE string - auto-populates service ticket approver field';
COMMENT ON COLUMN projects.other IS 'Other notes - auto-populates service ticket other field';
