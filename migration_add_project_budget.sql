-- Migration: Add budget to projects table

ALTER TABLE public.projects 
ADD COLUMN budget numeric(12,2) DEFAULT 0;