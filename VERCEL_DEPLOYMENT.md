# Vercel Deployment Configuration

## Your GitHub Repository
https://github.com/DeagsB/IONEX-Time-Tracking

## Deployment Steps

1. **Go to Vercel** (should open automatically): https://vercel.com/new

2. **Connect GitHub Repository**:
   - Sign in with GitHub if needed
   - Click "Import Git Repository"
   - Select: `DeagsB/IONEX-Time-Tracking`
   - Click "Import"

3. **Configure Project Settings**:
   - **Framework Preset**: Vite (should auto-detect)
   - **Root Directory**: `frontend` ← **IMPORTANT!**
   - **Build Command**: `npm run build` (should auto-fill)
   - **Output Directory**: `dist` (should auto-fill)
   - **Install Command**: `npm install` (should auto-fill)

4. **Add Environment Variables** (before clicking Deploy):
   Click "Environment Variables" and add:
   
   **VITE_SUPABASE_URL**
   - Value: Your Supabase project URL (from Supabase Dashboard → Settings → API)
   - Environment: Production, Preview, Development (select all)
   
   **VITE_SUPABASE_ANON_KEY**
   - Value: Your Supabase anon/public key (from Supabase Dashboard → Settings → API)
   - Environment: Production, Preview, Development (select all)
   
   **VITE_API_URL** (required for QuickBooks)
   - Value: Your backend API URL
   - Local dev: `http://localhost:3001` (run `npm run dev` from repo root)
   - Production: Deploy backend to Railway/Render/Fly.io, then use that URL
   - Environment: Production, Preview, Development (select all)
   
   > **Note**: Never commit API keys to version control. Get these values from your Supabase project dashboard.

5. **Deploy**:
   - Click "Deploy"
   - Wait 1-2 minutes for build to complete
   - Your app will be live at `https://your-project.vercel.app`

6. **After Deployment - Update Supabase**:
   - Go to Supabase Dashboard → Authentication → URL Configuration
   - Add to Redirect URLs:
     - `https://your-project.vercel.app`
     - `https://your-project.vercel.app/**`

## Important Notes

- ✅ Your code is already on GitHub
- ✅ Team: IONEX Systems' projects
- ⚠️ Remember to set Root Directory to `frontend`
- ⚠️ Don't forget to add environment variables before deploying

