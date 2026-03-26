-- Migration: Add pay rate columns to employees table
-- Run this in your Supabase SQL Editor

ALTER TABLE public.employees
ADD COLUMN IF NOT EXISTS shop_pay_rate DECIMAL(10, 2) DEFAULT 25.00,
ADD COLUMN IF NOT EXISTS field_pay_rate DECIMAL(10, 2) DEFAULT 30.00,
ADD COLUMN IF NOT EXISTS shop_ot_pay_rate DECIMAL(10, 2) DEFAULT 37.50,
ADD COLUMN IF NOT EXISTS field_ot_pay_rate DECIMAL(10, 2) DEFAULT 45.00;

-- Add comment to document that travel time is paid at shop rate
COMMENT ON COLUMN public.employees.shop_pay_rate IS 'Employee pay rate for shop time. Travel time is also paid at this rate.';
COMMENT ON COLUMN public.employees.field_pay_rate IS 'Employee pay rate for field time';
COMMENT ON COLUMN public.employees.shop_ot_pay_rate IS 'Employee pay rate for shop overtime';
COMMENT ON COLUMN public.employees.field_ot_pay_rate IS 'Employee pay rate for field overtime';

