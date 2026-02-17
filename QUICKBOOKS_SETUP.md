# QuickBooks Online – Setup Guide

Connect IONEX to QuickBooks so you can create invoices from the **Invoices** page and attach PDFs. Only **admin** users can connect QuickBooks (in **Profile**).

---

## 1. QuickBooks Developer Portal (app you created)

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in.
2. Open your app (or create one): **Dashboard** → **Your apps** → select the app.
3. Open **Keys & credentials** (or **Keys & OAuth**).
4. Copy:
   - **Client ID**
   - **Client Secret**
5. Under **Redirect URIs**, add **exactly** the URL your backend will use for the OAuth callback:
   - **Local:** `http://localhost:3001/api/quickbooks/callback`
   - **Production:** `https://YOUR-BACKEND-URL/api/quickbooks/callback`  
     (e.g. `https://ionex-api.railway.app/api/quickbooks/callback`)
6. Save. Use **Sandbox** for testing; switch to **Production** keys when going live.

---

## 2. Backend environment variables

Your **backend** (Node/Express) needs these. Set them in a `.env` in the backend folder or in your host’s env (Railway, Render, etc.).

| Variable | Required | Description |
|----------|----------|-------------|
| `QBO_CLIENT_ID` | Yes | From QuickBooks app → Keys & credentials |
| `QBO_CLIENT_SECRET` | Yes | From QuickBooks app → Keys & credentials |
| `QBO_REDIRECT_URI` | Yes | Must match a Redirect URI in the QuickBooks app (see above) |
| `FRONTEND_URL` | Yes | Where the app runs; used to redirect after OAuth (e.g. `http://localhost:5173` or `https://your-app.vercel.app`) |
| `SUPABASE_URL` | Yes | Supabase project URL (backend stores tokens in Supabase) |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase **service role** key (not anon key) |
| `QBO_ENVIRONMENT` | No | `sandbox` (default) or `production` |

**Example – local (backend root or `backend/.env`):**

```env
QBO_CLIENT_ID=your_client_id_from_quickbooks
QBO_CLIENT_SECRET=your_client_secret_from_quickbooks
QBO_REDIRECT_URI=http://localhost:3001/api/quickbooks/callback
FRONTEND_URL=http://localhost:5173
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=your_supabase_service_role_key
QBO_ENVIRONMENT=sandbox
```

**Example – production:**

```env
QBO_CLIENT_ID=...
QBO_CLIENT_SECRET=...
QBO_REDIRECT_URI=https://your-backend.railway.app/api/quickbooks/callback
FRONTEND_URL=https://your-app.vercel.app
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=...
QBO_ENVIRONMENT=production
```

---

## 3. Frontend environment variable

The frontend calls your backend for QuickBooks (status, auth URL, create invoice, attach PDF).

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend base URL (no trailing slash) |

- **Local:** `http://localhost:3001` (create `frontend/.env.local` or set in your run config).
- **Production (e.g. Vercel):** Set in Vercel → Project → Settings → Environment Variables, e.g. `https://your-backend.railway.app`, then redeploy.

---

## 4. Run and connect

1. **Start backend** (and frontend if needed):
   ```bash
   npm run dev
   ```
   Backend: `http://localhost:3001`. Frontend: usually `http://localhost:5173`.

2. **Quick check:** open `http://localhost:3001/api/health`. You should see something like:  
   `{"status":"ok","message":"IONEX Time Tracking API"}`

3. **Connect QuickBooks:**
   - Log in as an **admin** user.
   - Go to **Profile**.
   - In the QuickBooks section, click **Connect QuickBooks**.
   - You’ll be sent to QuickBooks to authorize; after approving, you’re redirected back to Profile. When connected, the Invoices page can create invoices in QuickBooks and attach PDFs.

---

## 5. Troubleshooting

- **“Cannot reach the backend”**  
  Frontend can’t call the API. Ensure the backend is running and `VITE_API_URL` points to it (e.g. `http://localhost:3001` locally).

- **“Only admins can connect QuickBooks”**  
  Connect is restricted to users with the ADMIN role.

- **Redirect URI mismatch**  
  `QBO_REDIRECT_URI` must match **exactly** one of the Redirect URIs in the QuickBooks app (including `http` vs `https` and port).

- **Invalid grant / token errors**  
  In sandbox, use a QuickBooks **Sandbox** company and Sandbox keys. For live, use Production keys and a real company.

- **Backend 500 on auth or invoice**  
  Check backend logs. Ensure all env vars above are set and that Supabase has the `qbo_tokens` table (migration applied).
