import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import { body, validationResult } from 'express-validator';

const router = express.Router();
const prisma = new PrismaClient();

// Get all time entries (filtered by user role)
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const where: any = {};

    // Regular users can only see their own entries
    if (req.user?.role !== 'ADMIN') {
      where.userId = req.user?.id;
    }

    // Optional filters
    if (req.query.userId) {
      where.userId = req.query.userId as string;
    }
    if (req.query.projectId) {
      where.projectId = req.query.projectId as string;
    }
    if (req.query.startDate && req.query.endDate) {
      where.date = {
        gte: new Date(req.query.startDate as string),
        lte: new Date(req.query.endDate as string),
      };
    }

    const timeEntries = await prisma.timeEntry.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        employee: true,
        project: {
          include: {
            customer: true,
          },
        },
      },
      orderBy: {
        date: 'desc',
      },
    });

    res.json(timeEntries);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get time entry by ID
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const timeEntry = await prisma.timeEntry.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        employee: true,
        project: {
          include: {
            customer: true,
          },
        },
      },
    });

    if (!timeEntry) {
      return res.status(404).json({ error: 'Time entry not found' });
    }

    // Users can only view their own entries unless admin
    if (req.user?.role !== 'ADMIN' && timeEntry.userId !== req.user?.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(timeEntry);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create time entry
router.post(
  '/',
  authenticate,
  [
    body('date').isISO8601(),
    body('hours').isFloat({ min: 0 }),
    body('rate').isFloat({ min: 0 }),
  ],
  async (req: AuthRequest, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        projectId,
        date,
        startTime,
        endTime,
        hours,
        rate,
        billable,
        description,
        employeeId,
      } = req.body;

      // Get project rate if not provided
      let finalRate = rate;
      if (!finalRate && projectId) {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
        });
        if (project) {
          finalRate = project.rate;
        }
      }

      // Get employee rate if not provided
      if (!finalRate && employeeId) {
        const employee = await prisma.employee.findUnique({
          where: { id: employeeId },
        });
        if (employee) {
          finalRate = employee.wageRate;
        }
      }

      const timeEntry = await prisma.timeEntry.create({
        data: {
          userId: req.user!.id,
          employeeId: employeeId || null,
          projectId: projectId || null,
          date: new Date(date),
          startTime: startTime ? new Date(startTime) : null,
          endTime: endTime ? new Date(endTime) : null,
          hours: parseFloat(hours),
          rate: finalRate,
          billable: billable !== undefined ? billable : true,
          description,
        },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          project: {
            include: {
              customer: true,
            },
          },
        },
      });

      res.status(201).json(timeEntry);
    } catch (error) {
      console.error('Create time entry error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Update time entry
router.put('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Check if entry exists and user has permission
    const existingEntry = await prisma.timeEntry.findUnique({
      where: { id },
    });

    if (!existingEntry) {
      return res.status(404).json({ error: 'Time entry not found' });
    }

    // Users can only update their own entries unless admin
    if (req.user?.role !== 'ADMIN' && existingEntry.userId !== req.user?.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Don't allow updates to approved entries unless admin
    if (existingEntry.approved && req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Cannot modify approved entry' });
    }

    const {
      projectId,
      date,
      startTime,
      endTime,
      hours,
      rate,
      billable,
      description,
    } = req.body;

    const updateData: any = {};
    if (date !== undefined) updateData.date = new Date(date);
    if (startTime !== undefined) updateData.startTime = startTime ? new Date(startTime) : null;
    if (endTime !== undefined) updateData.endTime = endTime ? new Date(endTime) : null;
    if (hours !== undefined) updateData.hours = parseFloat(hours);
    if (rate !== undefined) updateData.rate = parseFloat(rate);
    if (billable !== undefined) updateData.billable = billable;
    if (description !== undefined) updateData.description = description;
    if (projectId !== undefined) updateData.projectId = projectId;

    const timeEntry = await prisma.timeEntry.update({
      where: { id },
      data: updateData,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        project: {
          include: {
            customer: true,
          },
        },
      },
    });

    res.json(timeEntry);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve time entry (Admin only)
router.post('/:id/approve', authenticate, async (req: AuthRequest, res) => {
  try {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;

    const timeEntry = await prisma.timeEntry.update({
      where: { id },
      data: {
        approved: true,
        approvedBy: req.user.id,
        approvedAt: new Date(),
      },
    });

    res.json(timeEntry);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete time entry
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existingEntry = await prisma.timeEntry.findUnique({
      where: { id },
    });

    if (!existingEntry) {
      return res.status(404).json({ error: 'Time entry not found' });
    }

    // Users can only delete their own entries unless admin
    if (req.user?.role !== 'ADMIN' && existingEntry.userId !== req.user?.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.timeEntry.delete({
      where: { id },
    });

    res.json({ message: 'Time entry deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

