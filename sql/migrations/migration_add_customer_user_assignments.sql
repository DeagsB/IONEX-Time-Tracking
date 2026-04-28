-- Migration: Add customer-user assignments
-- This allows admins to assign customers to specific users
-- Regular users will see their own customers + assigned customers

-- Create customer_user_assignments junction table
CREATE TABLE IF NOT EXISTS public.customer_user_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(customer_id, user_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_customer_user_assignments_customer_id ON public.customer_user_assignments(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_user_assignments_user_id ON public.customer_user_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_customer_user_assignments_assigned_by ON public.customer_user_assignments(assigned_by);

-- Add comments
COMMENT ON TABLE public.customer_user_assignments IS 'Junction table for assigning customers to users. Regular users can see their own customers and assigned customers.';
COMMENT ON COLUMN public.customer_user_assignments.customer_id IS 'The customer being assigned';
COMMENT ON COLUMN public.customer_user_assignments.user_id IS 'The user the customer is assigned to';
COMMENT ON COLUMN public.customer_user_assignments.assigned_by IS 'The admin user who made the assignment';

-- Enable RLS
ALTER TABLE public.customer_user_assignments ENABLE ROW LEVEL SECURITY;

-- RLS Policies for customer_user_assignments
-- Admins can view all assignments
CREATE POLICY "Admins can view all assignments" ON public.customer_user_assignments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Users can view their own assignments
CREATE POLICY "Users can view own assignments" ON public.customer_user_assignments
  FOR SELECT
  USING (user_id = auth.uid());

-- Only admins can create assignments
CREATE POLICY "Admins can create assignments" ON public.customer_user_assignments
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Only admins can update assignments
CREATE POLICY "Admins can update assignments" ON public.customer_user_assignments
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );

-- Only admins can delete assignments
CREATE POLICY "Admins can delete assignments" ON public.customer_user_assignments
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'ADMIN'
    )
  );
