# Vercel Deployment Configuration

## Your GitHub Repository
https://github.com/DeagsB/IONEX-Time-Tracking

---

## Option A: Full stack on Vercel (frontend + API for QuickBooks)

Use this so the app and the QuickBooks API run on the same domain. The repo’s root `vercel.json` builds the backend and frontend and runs `/api/*` as serverless.

1. **Connect the repo** in Vercel and open the project.

2. **Project settings**:
   - **Root Directory**: leave **empty** (repo root), or set to **`.`**
   - **Framework Preset**: Other (or leave as detected)
   - **Build Command**: (use repo default from `vercel.json`: builds backend then frontend)
   - **Output Directory**: `frontend/dist`
   - **Install Command**: `npm install`

3. **Environment variables** (Settings → Environment Variables):

   **Frontend (build-time):**
   - `VITE_SUPABASE_URL` – Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` – Supabase anon key
   - `VITE_API_URL` – **Optional** for same-origin: the app uses the current origin in production if unset. Set to **`https://ionex-timer.vercel.app`** (or your Vercel URL) only if you need to override.

   **Backend / API (QuickBooks and Supabase):**
   - `QBO_CLIENT_ID` – QuickBooks app Client ID
   - `QBO_CLIENT_SECRET` – QuickBooks app Client Secret
   - `QBO_REDIRECT_URI` – **`https://ionex-timer.vercel.app/api/quickbooks/callback`**
   - `FRONTEND_URL` – **`https://ionex-timer.vercel.app`**
   - `SUPABASE_URL` – Supabase project URL
   - `SUPABASE_SERVICE_KEY` – Supabase **service role** key
   - `QBO_ENVIRONMENT` – `sandbox` or `production`

   Add them for **Production** (and **Preview** if you use preview envs).

4. **Deploy**  
   Push to your connected branch (or trigger a deploy). The build runs `npm run build:backend` then builds the frontend; `/api/*` is served by the serverless function.

5. **Supabase**  
   In Supabase → Authentication → URL Configuration, add your app URL (e.g. `https://ionex-timer.vercel.app` and `https://ionex-timer.vercel.app/**`).

6. **QuickBooks**  
   In the QuickBooks app’s Redirect URIs, add:  
   `https://ionex-timer.vercel.app/api/quickbooks/callback`

---

## Option B: Frontend only on Vercel (backend elsewhere)

If you run the backend on Railway, Render, Fly.io, etc.:

1. **Root Directory**: **`frontend`**
2. **Build Command**: `npm run build`
3. **Output Directory**: `dist`
4. **Environment variables**:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   - **`VITE_API_URL`** = your backend URL (e.g. `https://your-api.railway.app`)

Put all QuickBooks/Supabase backend env vars on the backend host, not in Vercel. Set **`FRONTEND_URL`** on the backend to your frontend origin (e.g. `https://ionex-timer.vercel.app`) so CORS allows the app to call the API. In QuickBooks, set Redirect URI to `https://your-backend-url/api/quickbooks/callback`.

---

## After deployment

- App: `https://ionex-timer.vercel.app` (or your project URL)
- API health: `https://ionex-timer.vercel.app/api/health`  
  You should see: `{"status":"ok","message":"IONEX Time Tracking API"}`

Do not commit secrets; set all of the above in the Vercel (or backend) dashboard.
