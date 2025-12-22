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
   - Value: `https://rfkjlysksehqcflcnlia.supabase.co`
   - Environment: Production, Preview, Development (select all)
   
   **VITE_SUPABASE_ANON_KEY**
   - Value: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJma2pseXNrc2VocWNmbGNubGlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYzNzcwNTYsImV4cCI6MjA4MTk1MzA1Nn0.VIrum6MCVZcASMdWznv7F6PhrMqoQm3FlsqeXVdWVRQ`
   - Environment: Production, Preview, Development (select all)

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

