-- Migration: Create employee records for existing users who don't have one
-- This ensures all users appear on the employees page

-- Function to get the next available employee ID starting from the highest existing one
CREATE OR REPLACE FUNCTION public.get_next_employee_id_for_migration()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  max_num INTEGER;
  next_num INTEGER;
BEGIN
  -- Find the highest numeric part of existing employee IDs
  SELECT COALESCE(MAX(CAST(SUBSTRING(employee_id FROM 4) AS INTEGER)), 0)
  INTO max_num
  FROM public.employees
  WHERE employee_id ~ '^EMP[0-9]+$';
  
  -- Start from the next number
  next_num := max_num + 1;
  
  -- Return formatted employee ID (EMP001, EMP002, etc.)
  RETURN 'EMP' || LPAD(next_num::TEXT, 3, '0');
END;
$$;

-- Create employee records for all users who don't have one
DO $$
DECLARE
  user_record RECORD;
  new_employee_id TEXT;
  current_num INTEGER := 0;
BEGIN
  -- Get the highest existing employee ID number
  SELECT COALESCE(MAX(CAST(SUBSTRING(employee_id FROM 4) AS INTEGER)), 0)
  INTO current_num
  FROM public.employees
  WHERE employee_id ~ '^EMP[0-9]+$';
  
  -- Loop through all users without employee records
  FOR user_record IN 
    SELECT u.id, u.email, u.first_name, u.last_name, u.created_at
    FROM public.users u
    LEFT JOIN public.employees e ON u.id = e.user_id
    WHERE e.id IS NULL
    ORDER BY u.created_at
  LOOP
    -- Increment the employee ID number
    current_num := current_num + 1;
    new_employee_id := 'EMP' || LPAD(current_num::TEXT, 3, '0');
    
    -- Create employee record
    INSERT INTO public.employees (
      user_id,
      employee_id,
      wage_rate,
      hire_date,
      status
    )
    VALUES (
      user_record.id,
      new_employee_id,
      25.00, -- Default wage rate
      COALESCE(user_record.created_at::DATE, CURRENT_DATE), -- Use user creation date or today
      'active'
    );
    
    RAISE NOTICE 'Created employee record % for user % (%)', new_employee_id, user_record.email, user_record.id;
  END LOOP;
  
  RAISE NOTICE 'Migration complete. Created employee records for all users without one.';
END;
$$;

-- Clean up the temporary function
DROP FUNCTION IF EXISTS public.get_next_employee_id_for_migration();

COMMENT ON FUNCTION public.get_next_employee_id() IS 'Generates the next sequential employee ID (EMP001, EMP002, etc.)';

