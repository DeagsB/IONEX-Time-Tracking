# IONEX Time Tracking - Setup Guide for Supabase + Vercel

## Prerequisites
- Node.js 18+ installed
- A Supabase account (free tier available at https://supabase.com)
- A Vercel account (free tier available at https://vercel.com)
- Git repository (GitHub recommended for easy Vercel deployment)

## Step 1: Create Supabase Project

1. Go to https://supabase.com and create a free account
2. Create a new project
3. Go to **Settings > API** and copy:
   - Project URL (e.g., `https://xxxxx.supabase.co`)
   - Anon/public key

## Step 2: Set Up Database Schema

1. In Supabase Dashboard, go to **SQL Editor**
2. Copy the contents of `supabase-schema.sql` from the root of this project
3. Paste and run it in the SQL Editor
4. This creates all tables, triggers, and Row Level Security policies

## Step 3: Enable Email Authentication Provider

1. In Supabase Dashboard, go to **Authentication > Providers**
2. Find **"Email"** in the list of providers
3. **Enable** the Email provider (toggle it ON)
4. This is required for email/password signups to work

## Step 4: Configure Email Settings (SMTP)

1. In Supabase Dashboard, go to **Settings > Auth > SMTP Settings**
2. Configure your SMTP provider:
   - **SMTP Host**: Your email provider's SMTP server
   - **SMTP Port**: Usually `587` (TLS) or `465` (SSL)
   - **SMTP User**: Your full email address
   - **SMTP Password**: Your email password or app-specific password
   - **Sender Email**: The email address that will appear as the sender
   - **Sender Name**: Display name for emails

3. **For Gmail users**: You'll need to use an [App Password](https://support.google.com/accounts/answer/185833) instead of your regular password

4. **Test the connection**: Use the "Send test email" feature if available

5. **Verify email templates**: Go to **Authentication > Email Templates** and ensure templates are configured with correct redirect URLs

> **Note**: See `SMTP_TROUBLESHOOTING.md` for detailed troubleshooting if emails aren't being received.

## Step 5: Enable Microsoft OAuth (Optional but Recommended)

1. In Supabase Dashboard, go to **Authentication > Providers**
2. Enable **Azure** provider
3. You'll need to:
   - Create an Azure AD app registration (https://portal.azure.com)
   - Get Client ID and Client Secret
   - Add redirect URL: `https://YOUR_SUPABASE_PROJECT.supabase.co/auth/v1/callback`
4. Enter these credentials in Supabase

## Step 6: Install Dependencies

```bash
cd frontend
npm install
```

## Step 7: Configure Environment Variables

1. Copy `env.example` to `.env.local`:
   ```bash
   cp env.example .env.local
   ```

2. Edit `.env.local` and add your Supabase credentials:
   ```
   VITE_SUPABASE_URL=https://xxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=your_anon_key_here
   ```

## Step 8: Test Locally

```bash
npm run dev
```

Visit `http://localhost:5173` and test the application.

## Step 9: Deploy to Vercel

### Option A: Deploy via Vercel CLI

1. Install Vercel CLI:
   ```bash
   npm i -g vercel
   ```

2. From the `frontend` directory, run:
   ```bash
   vercel
   ```

3. Follow the prompts and add environment variables when asked:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

### Option B: Deploy via GitHub (Recommended)

1. Push your code to GitHub
2. Go to https://vercel.com
3. Click "New Project"
4. Import your GitHub repository
5. Set **Root Directory** to `frontend`
6. Add environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
7. Click "Deploy"

## Step 10: Update Supabase Redirect URLs

After deploying to Vercel, update your Supabase redirect URLs:

1. Go to Supabase Dashboard > **Authentication > URL Configuration**
2. Add your Vercel URL to **Redirect URLs**:
   - `https://your-app.vercel.app`
   - `https://your-app.vercel.app/**`

## Step 11: Create First Admin User

1. Sign up through the app (either email/password or Microsoft OAuth)
2. Go to Supabase Dashboard > **Table Editor > users**
3. Find your user and change `role` from `USER` to `ADMIN`

## Architecture Overview

- **Frontend**: React + Vite (deployed on Vercel)
- **Database**: PostgreSQL (Supabase)
- **Authentication**: Supabase Auth (supports email/password and OAuth providers)
- **API**: Supabase REST API (auto-generated from database schema)
- **Row Level Security**: Enabled on all tables for data security

## Key Features

- ✅ Serverless (no backend code needed)
- ✅ Row Level Security for data isolation
- ✅ Microsoft OAuth support for enterprise SSO
- ✅ Automatic user profile creation
- ✅ Free tier available for both Supabase and Vercel

## Troubleshooting

### "Invalid API key" error
- Check that environment variables are set correctly in Vercel
- Ensure `.env.local` exists locally

### Can't login with Microsoft
- Verify Azure AD app registration is set up correctly
- Check redirect URLs match in both Azure and Supabase
- Ensure Azure provider is enabled in Supabase

### Database permission errors
- Check Row Level Security policies in Supabase
- Verify user role is set correctly in `users` table

### "Email signups are disabled" error
- Go to **Authentication > Providers** in Supabase Dashboard
- Enable the **Email** provider (toggle it ON)
- This must be enabled before email/password authentication will work

### Not receiving confirmation emails
- Check `SMTP_TROUBLESHOOTING.md` for detailed SMTP configuration help
- Verify SMTP settings in Supabase Dashboard
- Check spam/junk folder
- Ensure email confirmation is enabled in Authentication settings
- Review Supabase Auth logs for email sending errors
- Check that user profile exists in `public.users` table


