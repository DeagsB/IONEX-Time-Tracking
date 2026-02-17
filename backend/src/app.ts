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

// Allow frontend origin(s) so cross-origin API calls with Authorization work (e.g. Vercel → Railway)
const frontendUrl = process.env.FRONTEND_URL?.replace(/\/+$/, '');
const corsOriginsRaw = process.env.CORS_ORIGINS ?? '';
const allowedOrigins = [
  ...(frontendUrl ? [frontendUrl] : []),
  ...corsOriginsRaw.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
];
const corsOptions = {
  origin: allowedOrigins.length > 0
    ? (origin: string | undefined, cb: (err: Error | null, allow?: boolean | string) => void) => {
        if (!origin) return cb(null, true); // same-origin or tools like Postman
        const allow = allowedOrigins.includes(origin);
        return cb(null, allow ? origin : false);
      }
    : true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  optionsSuccessStatus: 200,
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
