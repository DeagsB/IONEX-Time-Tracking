# Railway setup guide – IONEX backend API

Use this when your **frontend** is on Vercel and you want the **backend** (QuickBooks API, auth, etc.) on Railway.

---

## 1. Create a Railway account and project

1. Go to **[railway.app](https://railway.app)** and sign in (GitHub is easiest).
2. Click **“New Project”**.
3. Choose **“Deploy from GitHub repo”**.
4. Select your GitHub account and the repo **`DeagsB/IONEX-Time-Tracking`** (or your fork). Authorize Railway if asked.
5. Railway will ask what to deploy. Choose **“Configure a service”** or **“Add a service”** so you can set the root directory in the next step.

---

## 2. Point the service at the `backend` folder

1. Click the new **service** (the box that represents your app).
2. Open the **Settings** tab (or the **⋮** menu → **Settings**).
3. Under **Source**:
   - **Root Directory**: set to **`backend`** (so Railway builds and runs only the backend, not the whole repo).
   - **Watch Paths** (if present): you can leave default so it redeploys when `backend/**` changes.
4. Under **Build** (or in the service settings):
   - **Build Command**: `npm install && npx prisma generate && npm run build`
   - **Start Command**: `npm run start`
   - **Output Directory**: leave empty (Node app, not static).
5. Save / let Railway pick up the config.

---

## 3. Add environment variables

1. In the same service, open the **Variables** tab.
2. Add these (replace placeholders with your real values):

| Variable | Example / value |
|----------|------------------|
| `PORT` | `3001` (optional; Railway often sets this) |
| `SUPABASE_URL` | `https://your-project.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Your Supabase **service role** key |
| `FRONTEND_URL` | `https://ionex-timer.vercel.app` (no trailing slash) |
| `QBO_CLIENT_ID` | QuickBooks app Client ID |
| `QBO_CLIENT_SECRET` | QuickBooks app Client Secret |
| `QBO_REDIRECT_URI` | `https://YOUR-RAILWAY-URL/api/quickbooks/callback` (see step 4) |
| `QBO_ENVIRONMENT` | `sandbox` or `production` |

3. **Optional (CORS):**  
   - For preview URLs, add: `CORS_ORIGINS` = `https://ionex-timer-pojl7qm4x-ionex-systems-projects.vercel.app` (or a comma-separated list).  
   - To allow any origin temporarily: `CORS_ORIGINS` = `*` (remove for production).

4. Save. Railway will redeploy when you change variables.

---

## 4. Get your public URL

1. In the service, open the **Settings** tab.
2. Under **Networking** or **Domains**, click **“Generate domain”** (or **“Add domain”**).
3. Railway will assign a URL like **`ionex-api-production-xxxx.up.railway.app`** (or you can add a custom domain later).
4. Copy this base URL (e.g. `https://ionex-api-production-xxxx.up.railway.app`).
5. **Update `QBO_REDIRECT_URI`** in Variables to:  
   `https://YOUR-RAILWAY-URL/api/quickbooks/callback`  
   (use the exact URL Railway gave you).

---

## 5. Check the deploy

1. In Railway, open the **Deployments** tab and wait for the latest deploy to succeed.
2. In a browser, open:
   - **`https://YOUR-RAILWAY-URL/api/health`**  
     You should see: `{"status":"ok","message":"IONEX Time Tracking API"}`.
   - **`https://YOUR-RAILWAY-URL/api/quickbooks/ping`**  
     You should see: `{"ok":true,"service":"quickbooks"}`.

If you get “Not found” or an error, double‑check **Root Directory** is `backend` and the build/start commands above.

---

## 6. Wire the frontend (Vercel) to Railway

1. In **Vercel** → your IONEX project → **Settings** → **Environment Variables**.
2. For **Production** (and Preview if you use it), set:
   - **`VITE_API_URL`** = your Railway URL, e.g. `https://ionex-api-production-xxxx.up.railway.app` (no trailing slash).
3. **Redeploy** the frontend (Deployments → ⋮ → Redeploy, or push a new commit) so the new value is baked in.

---

## 7. QuickBooks Developer Portal

1. In the [Intuit Developer](https://developer.intuit.com) portal, open your app.
2. Under **Keys & credentials** → **Redirect URIs**, add:
   - **`https://YOUR-RAILWAY-URL/api/quickbooks/callback`**
3. Save.

---

## Summary

- **Railway**: Root = `backend`, build = `npm install && npx prisma generate && npm run build`, start = `npm run start`, all env vars above, generate domain.
- **Vercel**: `VITE_API_URL` = Railway URL, redeploy.
- **QuickBooks**: Redirect URI = `https://YOUR-RAILWAY-URL/api/quickbooks/callback`.

After that, **Connect QuickBooks** on the Profile page should hit your Railway API and redirect to Intuit.
