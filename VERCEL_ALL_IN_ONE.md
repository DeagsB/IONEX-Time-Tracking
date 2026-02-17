# All on Vercel – checklist

Use this when you want **frontend + API** on one Vercel project (no Railway). QuickBooks and the app run at `https://ionex-timer.vercel.app` and `/api/*`.

---

## 1. Vercel project settings

- Go to [vercel.com](https://vercel.com) → your **IONEX Time Tracking** project → **Settings** → **General**.
- **Root Directory**: use **`backend`** (the repo has `backend/vercel.json` and `backend/api/` so frontend + API both deploy from this root).  
  **Do not** use **`frontend`** — that gives you no `/api/*` and Connect QuickBooks won’t work.
- **Build Command**, **Output Directory**, **Install Command**: leave as **default** (they come from `backend/vercel.json`: install from repo root, build backend + frontend, output `public`).

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
- Wait for the build to finish. With root = **backend**, the build runs from `backend/vercel.json`: install at repo root, then backend build + frontend build, then output to `public`.

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
