# Quick Setup Instructions

## Step 1: Run Setup

Double-click **`setup.bat`** to:
- Install all dependencies
- Set up the database
- Generate Prisma client
- Run database migrations

## Step 2: Start the Application

Double-click **`start-dev.bat`** to start both servers:
- Backend: http://localhost:3001
- Frontend: http://localhost:3000

## Step 3: Create Admin User

Open `create-admin.html` in your browser and fill out the form to create your first admin account.

**OR** use the API directly:
```bash
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

## Step 4: Login

1. Open http://localhost:3000 in your browser
2. Login with your credentials
3. Start using the application!

---

**Note:** If you get errors about Node.js not being found, make sure Node.js is installed from https://nodejs.org/ and restart your terminal after installation.

