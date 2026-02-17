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
const corsOriginsRaw = (process.env.CORS_ORIGINS ?? '').trim();
const allowAnyOrigin = corsOriginsRaw === '*';
const allowedOrigins = allowAnyOrigin
  ? []
  : [
      ...(frontendUrl ? [frontendUrl] : []),
      ...corsOriginsRaw.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
    ];
const corsOptions = {
  origin:
    allowAnyOrigin || allowedOrigins.length === 0
      ? true // allow any origin (reflect request origin)
      : (origin: string | undefined, cb: (err: Error | null, allow?: boolean | string) => void) => {
          if (!origin) return cb(null, true); // same-origin or tools like Postman
          const allow = allowedOrigins.some((o) => o === origin);
          if (!allow) {
            console.warn(`[CORS] Rejected origin: ${origin}. Allowed: ${allowedOrigins.join(', ') || 'FRONTEND_URL/CORS_ORIGINS'}`);
          }
          return cb(null, allow ? origin : false);
        },
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

// 404 for unknown API paths (so we return JSON, not default Express HTML)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

export default app;
