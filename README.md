# IONEX Time Tracking Software

A comprehensive time tracking application with user authentication, role-based access control, project management, and employee tracking.

## Features

- **User Authentication**: Secure login with JWT tokens
- **Role-Based Access Control**: Admin and User roles with different permissions
- **Time Entry Tracking**: Track time with rates and billable flags
- **Project Management**: Manage projects with customer associations and billing information
- **Customer Management**: Store customer information, billing details, and contact information
- **Employee Management**: Track employee wage rates, positions, and employment details
- **Form Submission**: Employees can submit forms (timesheets, expense reports, time-off requests)
- **Rate Management**: Assign rates to projects and employees with billable tracking

## Tech Stack

### Backend
- Node.js with Express
- TypeScript
- Prisma ORM
- SQLite Database (can be easily switched to PostgreSQL)
- JWT Authentication
- bcryptjs for password hashing

### Frontend
- React with TypeScript
- Vite
- React Router
- React Query (TanStack Query)
- Axios

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn

### Installation

1. Install dependencies for all workspaces:
```bash
npm run install:all
```

Or install manually:
```bash
npm install
cd backend && npm install
cd ../frontend && npm install
```

2. Set up the backend environment:
```bash
cd backend
cp .env.example .env
# Edit .env and set your JWT_SECRET
```

3. Set up the database:
```bash
cd backend
npm run prisma:generate
npm run prisma:migrate
```

4. Start the development servers:

```bash
# From root directory - runs both frontend and backend
npm run dev

# Or run separately:
# Backend (runs on http://localhost:3001)
npm run dev:backend

# Frontend (runs on http://localhost:3000)
npm run dev:frontend
```

## Default Admin User

After running migrations, you'll need to create a user. You can do this via:
1. The registration endpoint (POST /api/auth/register) - first user should be created as ADMIN
2. Or use Prisma Studio to create one directly: `cd backend && npm run prisma:studio`

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user

### Users
- `GET /api/users` - Get all users (Admin only)
- `GET /api/users/:id` - Get user by ID
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user (Admin only)

### Time Entries
- `GET /api/time-entries` - Get time entries (filtered by user role)
- `GET /api/time-entries/:id` - Get time entry by ID
- `POST /api/time-entries` - Create time entry
- `PUT /api/time-entries/:id` - Update time entry
- `POST /api/time-entries/:id/approve` - Approve time entry (Admin only)
- `DELETE /api/time-entries/:id` - Delete time entry

### Projects
- `GET /api/projects` - Get all projects
- `GET /api/projects/:id` - Get project by ID
- `POST /api/projects` - Create project (Admin only)
- `PUT /api/projects/:id` - Update project (Admin only)
- `DELETE /api/projects/:id` - Delete project (Admin only)

### Customers
- `GET /api/customers` - Get all customers
- `GET /api/customers/:id` - Get customer by ID
- `POST /api/customers` - Create customer (Admin only)
- `PUT /api/customers/:id` - Update customer (Admin only)
- `DELETE /api/customers/:id` - Delete customer (Admin only)

### Employees
- `GET /api/employees` - Get all employees
- `GET /api/employees/:id` - Get employee by ID
- `POST /api/employees` - Create employee (Admin only)
- `PUT /api/employees/:id` - Update employee (Admin only)
- `DELETE /api/employees/:id` - Delete employee (Admin only)

### Forms
- `GET /api/forms` - Get all forms (filtered by user role)
- `GET /api/forms/:id` - Get form by ID
- `POST /api/forms` - Submit a new form
- `PUT /api/forms/:id` - Update form status (Admin only)
- `DELETE /api/forms/:id` - Delete form

## Database Schema

The application uses Prisma with the following main models:
- **User**: User accounts with authentication
- **Employee**: Employee records linked to users with wage information
- **Customer**: Customer information and billing details
- **Project**: Projects associated with customers and rates
- **TimeEntry**: Time tracking entries with rates and billable flags
- **Form**: Employee form submissions (timesheets, expenses, etc.)

## Project Structure

```
├── backend/
│   ├── src/
│   │   ├── routes/        # API routes
│   │   ├── middleware/    # Auth middleware
│   │   └── index.ts       # Express app
│   ├── prisma/
│   │   └── schema.prisma  # Database schema
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── pages/         # React pages
│   │   ├── components/    # React components
│   │   ├── context/       # React context (Auth)
│   │   └── App.tsx
│   └── package.json
└── package.json           # Root workspace config
```

## Security

- Passwords are hashed using bcryptjs
- JWT tokens for authentication
- Role-based access control (RBAC)
- Input validation using express-validator
- SQL injection protection via Prisma ORM

## Production Deployment

Before deploying to production:

1. Change the JWT_SECRET in `.env` to a strong random string
2. Consider switching from SQLite to PostgreSQL or MySQL
3. Update the database URL in `.env`
4. Run migrations: `npm run prisma:migrate`
5. Build the frontend: `npm run build:frontend`
6. Build the backend: `npm run build:backend`

## License

Private - IONEX Systems Inc.

