-- Add profile preference columns to users table (timezone, date_format, time_format)
-- Run this in Supabase SQL Editor if you get "Could not find the 'date_format' column" when saving profile.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/Edmonton',
  ADD COLUMN IF NOT EXISTS date_format TEXT DEFAULT 'MM/DD/YYYY',
  ADD COLUMN IF NOT EXISTS time_format TEXT DEFAULT '12h';
