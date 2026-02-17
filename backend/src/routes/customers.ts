import express, { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { body, validationResult } from 'express-validator';

const router = express.Router();
const prisma = new PrismaClient();

// Get all customers
router.get('/', authenticate, async (req, res) => {
  try {
    const customers = await prisma.customer.findMany({
      include: {
        projects: true,
      },
    });
    res.json(customers);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get customer by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        projects: {
          include: {
            timeEntries: true,
          },
        },
      },
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json(customer);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create customer (Admin only)
router.post(
  '/',
  authenticate,
  authorize('ADMIN'),
  [body('name').trim().notEmpty()],
  async (req: AuthRequest, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        name,
        email,
        phone,
        address,
        city,
        state,
        zipCode,
        country,
        taxId,
        notes,
      } = req.body;

      const customer = await prisma.customer.create({
        data: {
          name,
          email,
          phone,
          address,
          city,
          state,
          zipCode,
          country,
          taxId,
          notes,
        },
      });

      res.status(201).json(customer);
    } catch (error) {
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Update customer (Admin only)
router.put('/:id', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      phone,
      address,
      city,
      state,
      zipCode,
      country,
      taxId,
      notes,
    } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) updateData.address = address;
    if (city !== undefined) updateData.city = city;
    if (state !== undefined) updateData.state = state;
    if (zipCode !== undefined) updateData.zipCode = zipCode;
    if (country !== undefined) updateData.country = country;
    if (taxId !== undefined) updateData.taxId = taxId;
    if (notes !== undefined) updateData.notes = notes;

    const customer = await prisma.customer.update({
      where: { id },
      data: updateData,
    });

    res.json(customer);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete customer (Admin only)
router.delete('/:id', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.customer.delete({
      where: { id },
    });

    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

