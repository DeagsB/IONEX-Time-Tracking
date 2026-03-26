-- Migration: Add internal rate column to employees table
-- This is the rate charged for internal (non-billable) work
-- Run this in your Supabase SQL Editor

ALTER TABLE public.employees
ADD COLUMN IF NOT EXISTS internal_rate DECIMAL(10, 2) DEFAULT 0.00;

-- Add comment to document this is the rate for internal work
COMMENT ON COLUMN public.employees.internal_rate IS 'Rate charged for internal (non-billable) work. Used when time entries are marked as non-billable.';
