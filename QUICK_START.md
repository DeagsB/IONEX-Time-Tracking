# Quick Start Guide

## Prerequisites

1. **Node.js** (v18 or higher) - Download from https://nodejs.org/

## Setup Steps

### Option 1: Using the Setup Script (Recommended)

1. Open PowerShell in this directory
2. Run the setup script:
   ```powershell
   .\setup.ps1
   ```

### Option 2: Manual Setup

1. **Install dependencies:**
   ```powershell
   npm install
   cd backend
   npm install
   npm run prisma:generate
   npm run prisma:migrate
   cd ../frontend
   npm install
   cd ..
   ```

2. **Environment file is already created** in `backend/.env`

## Starting the Application

Run from the root directory:
```powershell
npm run dev
```

This starts both:
- **Backend API**: http://localhost:3001
- **Frontend**: http://localhost:3000

## Creating Your First User

Since there's no registration page yet, you have two options:

### Option 1: Use Prisma Studio (Easiest)
```powershell
cd backend
npm run prisma:studio
```

1. Open Prisma Studio (usually opens in browser automatically)
2. Go to the `User` table
3. Click "Add record"
4. Fill in the fields:
   - **email**: your-email@example.com
   - **password**: Use a password hasher tool or create via API (see Option 2)
   - **firstName**: Your first name
   - **lastName**: Your last name
   - **role**: ADMIN (to get full access)

**Note**: For password, you can use this command to generate a hash:
```powershell
node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('yourpassword', 10).then(hash => console.log(hash));"
```

### Option 2: Use the API directly

You can register via API call:
```powershell
# Using curl or Postman
POST http://localhost:3001/api/auth/register
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "yourpassword",
  "firstName": "Admin",
  "lastName": "User",
  "role": "ADMIN"
}
```

## Logging In

1. Open http://localhost:3000 in your browser
2. Use the email and password you created
3. You'll be redirected to the dashboard

## Features Available

### As Admin:
- View and manage all users
- Create and manage customers
- Create and manage projects
- Create and manage employees
- View and approve/reject forms
- View all time entries

### As Regular User:
- View your own time entries
- Create new time entries
- View projects (read-only)
- Submit forms
- View your submitted forms

Enjoy using IONEX Time Tracking Software!

