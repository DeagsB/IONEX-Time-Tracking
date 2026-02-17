/**
 * Vercel serverless catch-all when Root Directory = backend.
 * Forwards /api/* to the Express app (backend/dist/app.js).
 * Ensures req.url starts with /api so Express routes match.
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
const handler = (req, res) => {
  if (req.url && !req.url.startsWith('/api')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  app(req, res);
};
module.exports = handler;
