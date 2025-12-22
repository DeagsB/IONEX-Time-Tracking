import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

// Get all users (Admin only)
router.get('/', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        employee: true,
      },
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user by ID
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Users can only view their own profile unless admin
    if (req.user?.role !== 'ADMIN' && req.user?.id !== id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        employee: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (Admin or self)
router.put('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Users can only update their own profile unless admin
    if (req.user?.role !== 'ADMIN' && req.user?.id !== id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { firstName, lastName, email, role } = req.body;
    const updateData: any = {};

    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (email) updateData.email = email;
    if (role && req.user?.role === 'ADMIN') updateData.role = role;

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (Admin only)
router.delete('/:id', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.user.delete({
      where: { id },
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

