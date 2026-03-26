-- Migration: Update get_next_employee_id to fill gaps in employee numbering
-- If EMP001 and EMP003 exist, the next employee will be assigned EMP002

-- Drop and recreate the function to find the first available gap
CREATE OR REPLACE FUNCTION public.get_next_employee_id()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  next_num INTEGER;
  max_num INTEGER;
BEGIN
  -- Find all existing employee numbers
  -- Look for the first gap in the sequence starting from 1
  SELECT MIN(num) INTO next_num
  FROM (
    -- Generate a series from 1 to max+1 and find missing numbers
    SELECT generate_series(1, COALESCE(
      (SELECT MAX(CAST(SUBSTRING(employee_id FROM 4) AS INTEGER)) + 1 
       FROM public.employees 
       WHERE employee_id ~ '^EMP[0-9]+$'), 
      1
    )) AS num
  ) AS all_nums
  WHERE num NOT IN (
    SELECT CAST(SUBSTRING(employee_id FROM 4) AS INTEGER)
    FROM public.employees
    WHERE employee_id ~ '^EMP[0-9]+$'
  );
  
  -- If no gap found (shouldn't happen, but just in case), use max + 1
  IF next_num IS NULL THEN
    SELECT COALESCE(MAX(CAST(SUBSTRING(employee_id FROM 4) AS INTEGER)), 0) + 1
    INTO next_num
    FROM public.employees
    WHERE employee_id ~ '^EMP[0-9]+$';
  END IF;
  
  -- Return formatted employee ID (EMP001, EMP002, etc.)
  RETURN 'EMP' || LPAD(next_num::TEXT, 3, '0');
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_next_employee_id() TO authenticated;

COMMENT ON FUNCTION public.get_next_employee_id() IS 'Generates the next available employee ID, filling in gaps (e.g., if EMP001 and EMP003 exist, returns EMP002)';
