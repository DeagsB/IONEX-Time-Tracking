-- Migration: Auto-assign employee ID to new users
-- This creates an employee record automatically when a new user signs up

-- Function to generate next employee ID (e.g., EMP001, EMP002, etc.)
CREATE OR REPLACE FUNCTION public.get_next_employee_id()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  max_id TEXT;
  next_num INTEGER;
BEGIN
  -- Find the highest numeric part of existing employee IDs
  SELECT COALESCE(MAX(CAST(SUBSTRING(employee_id FROM 4) AS INTEGER)), 0)
  INTO next_num
  FROM public.employees
  WHERE employee_id ~ '^EMP[0-9]+$';
  
  -- Increment and format as EMP### (3 digits)
  next_num := next_num + 1;
  
  -- Return formatted employee ID (EMP001, EMP002, etc.)
  RETURN 'EMP' || LPAD(next_num::TEXT, 3, '0');
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_next_employee_id() TO authenticated;

-- Update the handle_new_user function to also create an employee record
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_employee_id TEXT;
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
  
  -- Generate next employee ID
  new_employee_id := public.get_next_employee_id();
  
  -- Create employee record with auto-assigned ID
  INSERT INTO public.employees (
    user_id,
    employee_id,
    wage_rate,
    hire_date,
    status
  )
  VALUES (
    NEW.id,
    new_employee_id,
    25.00, -- Default wage rate (can be updated later)
    CURRENT_DATE, -- Default hire date to today
    'active'
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Ensure the trigger exists (drop and recreate to be safe)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

COMMENT ON FUNCTION public.get_next_employee_id() IS 'Generates the next sequential employee ID (EMP001, EMP002, etc.)';
COMMENT ON FUNCTION public.handle_new_user() IS 'Automatically creates user profile and employee record with auto-assigned employee ID when a new user signs up';

