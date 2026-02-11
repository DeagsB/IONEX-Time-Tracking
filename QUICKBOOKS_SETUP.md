# QuickBooks Connect Troubleshooting

## "Cannot reach the backend" Error

This means the frontend cannot reach your backend API. Fix it based on your setup:

### Local Development

1. **Start the backend** from the project root:
   ```bash
   npm run dev
   ```
   This starts both frontend and backend. The backend runs on http://localhost:3001.

2. **Or run backend only** (if frontend is already running):
   ```bash
   npm run dev:backend
   ```

3. **Set VITE_API_URL** in `frontend/.env.local` (optional for local):
   ```
   VITE_API_URL=http://localhost:3001
   ```

### Production (Vercel-deployed frontend)

1. **Deploy the backend** to Railway, Render, Fly.io, or similar.
2. **Set VITE_API_URL** in Vercel:
   - Vercel Dashboard → Project → Settings → Environment Variables
   - Add `VITE_API_URL` = your backend URL (e.g. `https://ionex-api.railway.app`)
   - Redeploy the frontend

3. **QuickBooks backend env vars** (on your backend host):
   - `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`
   - `QBO_REDIRECT_URI` (e.g. `https://your-backend.railway.app/api/quickbooks/callback`)
   - `FRONTEND_URL` (e.g. `https://your-app.vercel.app`)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`

## Quick Test

Check if the backend is reachable:
- Local: open http://localhost:3001/api/health
- Production: open `https://your-backend-url/api/health`

You should see: `{"status":"ok","message":"IONEX Time Tracking API"}`
