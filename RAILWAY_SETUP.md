# Railway setup – IONEX backend API

Use this to run the **backend** (Node/Express API) on Railway so your Vercel frontend can call it (e.g. QuickBooks connect).

## 1. Create a Railway account and project

1. Go to **[railway.app](https://railway.app)** and sign in (GitHub is easiest).
2. Click **“New Project”**.
3. Choose **“Deploy from GitHub repo”** and select your **IONEX-Time-Tracking** repository.
4. When asked which repo to use, pick **DeagsB/IONEX-Time-Tracking** (or your fork). Railway will create a new service from it.

## 2. Configure the service to use the `backend` folder

Railway will deploy the **root** of the repo by default. We need it to use the **backend** folder only.

1. Click the **service** (the box that was created).
2. Open the **Settings** tab (or the **⋮** menu → **Settings**).
3. Under **Source** / **Root Directory** (or **Build**):
   - Set **Root Directory** to **`backend`**  
     (so the working directory for build and start is `backend/`).

If Railway doesn’t show “Root Directory”, look for **Build** → **Custom build command** and use:

- **Build command:** `npx prisma generate && npm run build`
- **Start command:** `npm run start`

(If Root Directory is set to `backend`, the default **Build** = `npm run build` and **Start** = `npm run start` are usually enough, and `postinstall` in `backend/package.json` runs `prisma generate`.)

## 3. Add environment variables

In the same service:

1. Open the **Variables** tab.
2. Add these (replace placeholders with your real values):

| Variable | Example / notes |
|----------|------------------|
| `PORT` | `3001` (optional; Railway often sets this) |
| `SUPABASE_URL` | `https://your-project.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Your Supabase **service role** key |
| `FRONTEND_URL` | `https://ionex-timer.vercel.app` (no trailing slash) |
| `QBO_CLIENT_ID` | QuickBooks app Client ID |
| `QBO_CLIENT_SECRET` | QuickBooks app Client Secret |
| `QBO_REDIRECT_URI` | **Must match the URL from step 5** (e.g. `https://your-app.up.railway.app/api/quickbooks/callback`) |
| `QBO_ENVIRONMENT` | `sandbox` or `production` |

Optional:

- `CORS_ORIGINS` – comma-separated extra origins, or `*` for debugging only.

Save. Railway will redeploy with the new variables.

## 4. Get your public URL

1. In the service, open the **Settings** tab.
2. Under **Networking** / **Public Networking**, click **Generate Domain** (or **Add domain**).
3. Railway will assign a URL like **`https://ionex-time-tracking-production-xxxx.up.railway.app`** (or similar). Copy it.

This is your **backend base URL**. No trailing slash when you use it in config (e.g. `https://your-app.up.railway.app`).

## 5. Point the frontend and QuickBooks at the backend

1. **Vercel (frontend)**  
   - Project → **Settings** → **Environment Variables**.  
   - Add (or update) for **Production** (and Preview if you use it):  
     **`VITE_API_URL`** = your Railway URL, e.g. `https://your-app.up.railway.app`  
   - **Redeploy** the frontend so the new value is used.

2. **QuickBooks Developer Portal**  
   - In your QuickBooks app settings, set **Redirect URI** to:  
     **`https://your-railway-url/api/quickbooks/callback`**  
     (same base URL as above, path `/api/quickbooks/callback`).

3. **Railway `QBO_REDIRECT_URI`**  
   - In Railway **Variables**, set **`QBO_REDIRECT_URI`** to that same URL:  
     `https://your-railway-url/api/quickbooks/callback`

## 6. Check that the backend is running

In a browser, open:

- **`https://your-railway-url/api/health`**  
  You should see something like: `{"status":"ok","message":"IONEX Time Tracking API"}`.
- **`https://your-railway-url/api/quickbooks/ping`**  
  You should see: `{"ok":true,"service":"quickbooks"}`.

If you get 404 or an error, check **Root Directory** is `backend` and that the latest commit (with QuickBooks routes) is deployed.

## 7. Test Connect QuickBooks

1. Open your **production** frontend (e.g. `https://ionex-timer.vercel.app`).
2. Sign in as an **admin**.
3. Go to **Profile** and click **Connect QuickBooks**.  
   You should be sent to Intuit to authorize, then back to Profile with success.

If you still see “Cannot reach the backend”, double-check **VITE_API_URL** on Vercel and that you redeployed the frontend after changing it.
