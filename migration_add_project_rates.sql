-- Migration: Add project-specific rate fields for Junior/Senior employees
-- These rates override client rates when set, based on employee status

-- Add rate columns to projects table
ALTER TABLE public.projects
ADD COLUMN IF NOT EXISTS shop_junior_rate DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS shop_senior_rate DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS ft_junior_rate DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS ft_senior_rate DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS travel_rate DECIMAL(10, 2);

-- Add rate columns to projects_demo table (if it exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'projects_demo') THEN
    ALTER TABLE public.projects_demo
    ADD COLUMN IF NOT EXISTS shop_junior_rate DECIMAL(10, 2),
    ADD COLUMN IF NOT EXISTS shop_senior_rate DECIMAL(10, 2),
    ADD COLUMN IF NOT EXISTS ft_junior_rate DECIMAL(10, 2),
    ADD COLUMN IF NOT EXISTS ft_senior_rate DECIMAL(10, 2),
    ADD COLUMN IF NOT EXISTS travel_rate DECIMAL(10, 2);
  END IF;
END $$;

-- Add comments for documentation
COMMENT ON COLUMN public.projects.shop_junior_rate IS 'Override rate for Shop Time - Junior employees ($/hr)';
COMMENT ON COLUMN public.projects.shop_senior_rate IS 'Override rate for Shop Time - Senior employees ($/hr)';
COMMENT ON COLUMN public.projects.ft_junior_rate IS 'Override rate for Field Time - Junior employees ($/hr)';
COMMENT ON COLUMN public.projects.ft_senior_rate IS 'Override rate for Field Time - Senior employees ($/hr)';
COMMENT ON COLUMN public.projects.travel_rate IS 'Override rate for Travel Time ($/hr)';
