-- Migration: Add billable rate columns to employees table
-- These are the rates charged to customers (different from pay rates)
-- Run this in your Supabase SQL Editor

ALTER TABLE public.employees
ADD COLUMN IF NOT EXISTS rt_rate DECIMAL(10, 2) DEFAULT 110.00,
ADD COLUMN IF NOT EXISTS tt_rate DECIMAL(10, 2) DEFAULT 85.00,
ADD COLUMN IF NOT EXISTS ft_rate DECIMAL(10, 2) DEFAULT 140.00,
ADD COLUMN IF NOT EXISTS shop_ot_rate DECIMAL(10, 2) DEFAULT 165.00,
ADD COLUMN IF NOT EXISTS field_ot_rate DECIMAL(10, 2) DEFAULT 165.00;

-- Add comments to document these are billable rates (what customers are charged)
COMMENT ON COLUMN public.employees.rt_rate IS 'Billable rate for regular time (shop time) - what customers are charged';
COMMENT ON COLUMN public.employees.tt_rate IS 'Billable rate for travel time - what customers are charged';
COMMENT ON COLUMN public.employees.ft_rate IS 'Billable rate for field time - what customers are charged';
COMMENT ON COLUMN public.employees.shop_ot_rate IS 'Billable rate for shop overtime - what customers are charged';
COMMENT ON COLUMN public.employees.field_ot_rate IS 'Billable rate for field overtime - what customers are charged';
