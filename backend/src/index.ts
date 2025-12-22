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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/time-entries', timeEntryRoutes);
app.use('/api/forms', formRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'IONEX Time Tracking API' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

