-- Migration: Add department to employee record creation on signup
-- This updates the handle_new_user function to include department from user metadata

-- Update the handle_new_user function to include department
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_employee_id TEXT;
  user_department TEXT;
BEGIN
  -- Create user profile
  INSERT INTO public.users (id, email, first_name, last_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'last_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'USER')
  );
  
  -- Get department from user metadata
  user_department := NEW.raw_user_meta_data->>'department';
  
  -- Generate next employee ID
  new_employee_id := public.get_next_employee_id();
  
  -- Create employee record with auto-assigned ID and department
  INSERT INTO public.employees (
    user_id,
    employee_id,
    wage_rate,
    hire_date,
    status,
    department
  )
  VALUES (
    NEW.id,
    new_employee_id,
    25.00, -- Default wage rate (can be updated later)
    CURRENT_DATE, -- Default hire date to today
    'active',
    user_department -- Department from signup form
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.handle_new_user() IS 'Automatically creates user profile and employee record with auto-assigned employee ID and department when a new user signs up';
