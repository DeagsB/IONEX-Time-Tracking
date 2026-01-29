# Vercel Deployment Guide

## Prerequisites
- A GitHub account (recommended for easiest deployment)
- A Vercel account (sign up at https://vercel.com - free tier is available)

## Method 1: Deploy via GitHub (Recommended - Easiest)

### Step 1: Push Your Code to GitHub

1. If you haven't already, create a new repository on GitHub
2. From your project root directory, initialize git and push:
   ```bash
   git init
   git add .
   git commit -m "Initial commit - IONEX Time Tracking"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
   git push -u origin main
   ```

### Step 2: Import to Vercel

1. Go to https://vercel.com and sign in (you can use GitHub to sign in)
2. Click **"Add New..."** → **"Project"**
3. Click **"Import Git Repository"**
4. Select your repository from the list
5. Configure the project:
   - **Framework Preset**: Vite (should auto-detect)
   - **Root Directory**: `frontend` (IMPORTANT: Set this!)
   - **Build Command**: `npm run build` (should auto-fill)
   - **Output Directory**: `dist` (should auto-fill)
   - **Install Command**: `npm install` (should auto-fill)

### Step 3: Add Environment Variables

Before clicking "Deploy", click **"Environment Variables"** and add:

1. **VITE_SUPABASE_URL**
   - Value: Your Supabase project URL (found in Supabase Dashboard → Settings → API)
   - Apply to: Production, Preview, Development (check all)

2. **VITE_SUPABASE_ANON_KEY**
   - Value: Your Supabase anon/public key (found in Supabase Dashboard → Settings → API)
   - Apply to: Production, Preview, Development (check all)

> **Note**: Get these values from your Supabase project dashboard. Never commit API keys to version control.

### Step 4: Deploy

1. Click **"Deploy"**
2. Wait 1-2 minutes for the build to complete
3. Your app will be live at `https://your-project-name.vercel.app`

### Step 5: Update Supabase Redirect URLs

After deployment, update your Supabase auth settings:

1. Go to Supabase Dashboard → **Authentication** → **URL Configuration**
2. Add to **Redirect URLs**:
   - `https://your-project-name.vercel.app`
   - `https://your-project-name.vercel.app/**`

---

## Method 2: Deploy via Vercel CLI

### Step 1: Install Vercel CLI

```bash
npm install -g vercel
```

### Step 2: Navigate to Frontend Directory

```bash
cd "IONEX Time Tracking Software/frontend"
```

### Step 3: Login to Vercel

```bash
vercel login
```

### Step 4: Deploy

```bash
vercel
```

Follow the prompts:
- Set up and deploy? **Yes**
- Which scope? (select your account)
- Link to existing project? **No** (first time) or **Yes** (if updating)
- Project name: (press Enter for default or type a name)
- Directory: `./` (current directory)
- Override settings? **No**

### Step 5: Add Environment Variables

After first deployment, add environment variables:

```bash
vercel env add VITE_SUPABASE_URL
# When prompted, paste your Supabase project URL (from Supabase Dashboard → Settings → API)
# Select: Production, Preview, Development

vercel env add VITE_SUPABASE_ANON_KEY
# When prompted, paste your Supabase anon/public key (from Supabase Dashboard → Settings → API)
# Select: Production, Preview, Development
```

> **Note**: Get these values from your Supabase project dashboard. Never commit API keys to version control.

### Step 6: Redeploy with Environment Variables

```bash
vercel --prod
```

---

## After Deployment

1. **Update Supabase Redirect URLs** (important for Microsoft OAuth):
   - Go to Supabase Dashboard → Authentication → URL Configuration
   - Add your Vercel URL to Redirect URLs

2. **Test the Deployment**:
   - Visit your Vercel URL
   - Try signing up/login
   - Test creating time entries

3. **Create First Admin User**:
   - Sign up through the app
   - Go to Supabase Dashboard → Table Editor → `users` table
   - Find your user and change `role` from `USER` to `ADMIN`

---

## Continuous Deployment

Once connected to GitHub, Vercel will automatically deploy:
- Every push to `main` branch → Production
- Every pull request → Preview deployment

No manual deployment needed! 🎉

---

## Troubleshooting

### Build fails
- Check that **Root Directory** is set to `frontend` in Vercel settings
- Verify `package.json` has the `build` script
- Check build logs in Vercel dashboard

### Environment variables not working
- Make sure variables are prefixed with `VITE_`
- Redeploy after adding environment variables
- Check that variables are applied to Production/Preview/Development

### App loads but API calls fail
- Verify Supabase URL and keys are correct
- Check Supabase dashboard → API → make sure project is active
- Check browser console for CORS or auth errors


