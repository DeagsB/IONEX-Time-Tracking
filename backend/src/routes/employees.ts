import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { body, validationResult } from 'express-validator';

const router = express.Router();
const prisma = new PrismaClient();

// Get all employees
router.get('/', authenticate, async (req, res) => {
  try {
    const employees = await prisma.employee.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
          },
        },
      },
    });
    res.json(employees);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get employee by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
          },
        },
        timeEntries: true,
        forms: true,
      },
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    res.json(employee);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create employee (Admin only)
router.post(
  '/',
  authenticate,
  authorize('ADMIN'),
  [
    body('userId').notEmpty(),
    body('employeeId').notEmpty(),
    body('wageRate').isFloat({ min: 0 }),
    body('hireDate').isISO8601(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        userId,
        employeeId,
        wageRate,
        hourlyRate,
        salary,
        hireDate,
        department,
        position,
        status,
      } = req.body;

      const employee = await prisma.employee.create({
        data: {
          userId,
          employeeId,
          wageRate,
          hourlyRate,
          salary,
          hireDate: new Date(hireDate),
          department,
          position,
          status: status || 'active',
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              role: true,
            },
          },
        },
      });

      res.status(201).json(employee);
    } catch (error: any) {
      if (error.code === 'P2002') {
        return res.status(400).json({ error: 'Employee ID already exists' });
      }
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Update employee (Admin only)
router.put('/:id', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      wageRate,
      hourlyRate,
      salary,
      department,
      position,
      status,
    } = req.body;

    const updateData: any = {};
    if (wageRate !== undefined) updateData.wageRate = wageRate;
    if (hourlyRate !== undefined) updateData.hourlyRate = hourlyRate;
    if (salary !== undefined) updateData.salary = salary;
    if (department !== undefined) updateData.department = department;
    if (position !== undefined) updateData.position = position;
    if (status !== undefined) updateData.status = status;

    const employee = await prisma.employee.update({
      where: { id },
      data: updateData,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
          },
        },
      },
    });

    res.json(employee);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete employee (Admin only)
router.delete('/:id', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.employee.delete({
      where: { id },
    });

    res.json({ message: 'Employee deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

