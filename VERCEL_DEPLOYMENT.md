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

### Deploying the backend to Railway

- **Root Directory**: set to **`backend`** (so Railway builds and runs from the `backend` folder).
- **Build**: `npm install && npm run build` (or use Railway’s default Node detection).
- **Start**: `npm run start` (runs `node dist/index.js`).
- Deploy from a branch that includes the QuickBooks routes (e.g. `feature/quickbooks-connect` or `main` after merge). After deploy, open **`https://your-railway-url/api/health`** and **`https://your-railway-url/api/quickbooks/ping`** in the browser; you should see JSON (`{"status":"ok",...}` and `{"ok":true,"service":"quickbooks"}`). If you get “Not found” or 404, the app or path is wrong—check Root Directory and that the latest code is deployed.

---

## After deployment

- App: `https://ionex-timer.vercel.app` (or your project URL)
- API health: `https://ionex-timer.vercel.app/api/health`  
  You should see: `{"status":"ok","message":"IONEX Time Tracking API"}`

Do not commit secrets; set all of the above in the Vercel (or backend) dashboard.

---

## Troubleshooting "Cannot reach the backend" / "Backend is not reachable"

When the frontend (e.g. Vercel) calls a separate API (e.g. Railway):

1. **Open the API health URL in your browser** (same origin as the app):  
   `https://your-api.railway.app/api/health`  
   You should see `{"status":"ok",...}`. If you get an error or nothing, the API is down or the URL is wrong.

2. **CORS**: On the **backend** (Railway), set **`FRONTEND_URL`** to your main app URL (e.g. `https://ionex-timer.vercel.app`). For **preview deployments** (e.g. `https://ionex-timer-pojl7qm4x-ionex-systems-projects.vercel.app`), add **`CORS_ORIGINS`** with the **exact** origin(s), comma-separated, no trailing slash:
   - Example: `CORS_ORIGINS=https://ionex-timer-pojl7qm4x-ionex-systems-projects.vercel.app`
   - Or allow any origin temporarily: `CORS_ORIGINS=*`. Redeploy the backend after changing env vars.

3. **Frontend**: Set **`VITE_API_URL`** to your backend URL, e.g. `https://ionex-api.railway.app` (no trailing slash). Rebuild/redeploy the frontend so the env is baked in.
