/**
 * Vercel serverless catch-all when Root Directory = backend.
 * Forwards /api/* to the Express app (backend/dist/app.js).
 * Wrapped so load failures return 500 instead of FUNCTION_INVOCATION_FAILED.
 */
let app;
try {
  const mod = require('../dist/app.js');
  app = mod.default || mod;
} catch (e) {
  console.error('[API load error]', e);
  app = (_req, res) => {
    res.status(500).json({ error: 'API failed to load', message: e.message });
  };
}
module.exports = app;
