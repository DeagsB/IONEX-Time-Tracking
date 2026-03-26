import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { body, validationResult } from 'express-validator';

const router = express.Router();
const prisma = new PrismaClient();

// Get all forms (filtered by user role)
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const where: any = {};

    // Regular users can only see forms for their employee record
    if (req.user?.role !== 'ADMIN') {
      const employee = await prisma.employee.findUnique({
        where: { userId: req.user!.id },
      });
      if (employee) {
        where.employeeId = employee.id;
      } else {
        return res.json([]);
      }
    }

    // Optional filters
    if (req.query.employeeId && req.user?.role === 'ADMIN') {
      where.employeeId = req.query.employeeId as string;
    }
    if (req.query.status) {
      where.status = req.query.status as string;
    }
    if (req.query.formType) {
      where.formType = req.query.formType as string;
    }

    const forms = await prisma.form.findMany({
      where,
      include: {
        employee: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: {
        submittedAt: 'desc',
      },
    });

    res.json(forms);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get form by ID
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const form = await prisma.form.findUnique({
      where: { id },
      include: {
        employee: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!form) {
      return res.status(404).json({ error: 'Form not found' });
    }

    // Users can only view forms for their employee record unless admin
    if (req.user?.role !== 'ADMIN') {
      const employee = await prisma.employee.findUnique({
        where: { userId: req.user!.id },
      });
      if (!employee || form.employeeId !== employee.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    res.json(form);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create form
router.post(
  '/',
  authenticate,
  [
    body('formType').trim().notEmpty(),
    body('title').trim().notEmpty(),
    body('content').notEmpty(),
  ],
  async (req: AuthRequest, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // Find employee record for user
      const employee = await prisma.employee.findUnique({
        where: { userId: req.user!.id },
      });

      if (!employee) {
        return res.status(400).json({ error: 'Employee record not found' });
      }

      const { formType, title, content, notes } = req.body;

      const form = await prisma.form.create({
        data: {
          employeeId: employee.id,
          formType,
          title,
          content: typeof content === 'object' ? JSON.stringify(content) : content,
          notes,
        },
        include: {
          employee: {
            include: {
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },
        },
      });

      res.status(201).json(form);
    } catch (error) {
      console.error('Create form error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Update form status (Admin only)
router.put('/:id', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const updateData: any = {};
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;

    if (status === 'approved' || status === 'rejected') {
      updateData.reviewedAt = new Date();
    }

    const form = await prisma.form.update({
      where: { id },
      data: updateData,
      include: {
        employee: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
    });

    res.json(form);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete form
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existingForm = await prisma.form.findUnique({
      where: { id },
    });

    if (!existingForm) {
      return res.status(404).json({ error: 'Form not found' });
    }

    // Users can only delete their own forms unless admin
    if (req.user?.role !== 'ADMIN') {
      const employee = await prisma.employee.findUnique({
        where: { userId: req.user!.id },
      });
      if (!employee || existingForm.employeeId !== employee.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    await prisma.form.delete({
      where: { id },
    });

    res.json({ message: 'Form deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

