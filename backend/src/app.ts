/**
 * Express app - exported for use by index.ts (local server) and Vercel serverless
 */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import employeeRoutes from './routes/employees';
import projectRoutes from './routes/projects';
import customerRoutes from './routes/customers';
import timeEntryRoutes from './routes/timeEntries';
import formRoutes from './routes/forms';
import quickbooksRoutes from './routes/quickbooks';

dotenv.config();

const app = express();

// Allow frontend origin (e.g. Vercel → Railway) so cross-origin API calls with Authorization work
const frontendUrl = process.env.FRONTEND_URL?.replace(/\/+$/, '');
const corsOptions: { origin: string | true; credentials: boolean; allowedHeaders: string[] } = {
  origin: frontendUrl || true, // specific origin when set, else reflect request origin (local dev)
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' })); // Increased limit for PDF uploads

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/time-entries', timeEntryRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/quickbooks', quickbooksRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'IONEX Time Tracking API' });
});

export default app;
