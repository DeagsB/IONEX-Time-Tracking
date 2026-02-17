# All on Vercel – checklist

Use this when you want **frontend + API** on one Vercel project (no Railway). QuickBooks and the app run at `https://ionex-timer.vercel.app` and `/api/*`.

---

## 1. Vercel project settings

- Go to [vercel.com](https://vercel.com) → your **IONEX Time Tracking** project → **Settings** → **General**.
- **Root Directory**: must be the **repository root** (so `vercel.json` and `api/` at the top of the repo are used).  
  **Do not** choose **`backend`** or **`frontend`** — with `backend` you get no frontend and the API route won’t work; with `frontend` you get no `/api/*`.
  - If the UI lets you clear the field or set **`.`**, do that and Save.
  - **If you can’t save empty or `.`:** create a **new project** instead:
    1. **Add New** → **Project** → import the same Git repo (**DeagsB/IONEX-Time-Tracking**).
    2. When asked for “Root Directory”, leave the default (don’t choose `frontend` or any subdirectory). That keeps the repo root.
    3. Add the env vars below, then deploy. Use the new project’s URL (e.g. `https://ionex-time-tracking-xxx.vercel.app`) or add your custom domain to this new project.
- **Build Command**: leave default (from `vercel.json`: `npm run build:backend && cd frontend && npm run build`).
- **Output Directory**: `frontend/dist`.
- **Install Command**: `npm install`.

Save.

---

## 2. Environment variables

**Settings** → **Environment Variables**. Add for **Production** (and **Preview** if you use it):

| Name | Value |
|------|--------|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_URL` | Same Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase **service role** key |
| `FRONTEND_URL` | `https://ionex-timer.vercel.app` |
| `QBO_CLIENT_ID` | QuickBooks app Client ID |
| `QBO_CLIENT_SECRET` | QuickBooks app Client Secret |
| `QBO_REDIRECT_URI` | `https://ionex-timer.vercel.app/api/quickbooks/callback` |
| `QBO_ENVIRONMENT` | `sandbox` or `production` |

- **Do not** set `VITE_API_URL` (the app will use the same origin for the API).
- Save and redeploy so new variables are applied.

---

## 3. Deploy

- **Deployments** → **Redeploy** (or push a commit to the connected branch).
- Wait for the build to finish. It runs backend build (Prisma + TypeScript) then frontend build.

---

## 4. Verify

- **App:** https://ionex-timer.vercel.app  
- **API health:** https://ionex-timer.vercel.app/api/health  
  Should return: `{"status":"ok","message":"IONEX Time Tracking API"}`  
- **QuickBooks ping:** https://ionex-timer.vercel.app/api/quickbooks/ping  
  Should return: `{"ok":true,"service":"quickbooks"}`

---

## 5. QuickBooks (Intuit Developer)

- In your app’s **Redirect URIs**, add:  
  `https://ionex-timer.vercel.app/api/quickbooks/callback`

---

## 6. Supabase (optional)

- **Authentication** → **URL Configuration**: add  
  `https://ionex-timer.vercel.app` and `https://ionex-timer.vercel.app/**`

---

After this, **Connect QuickBooks** on the Profile page should work without Railway.
