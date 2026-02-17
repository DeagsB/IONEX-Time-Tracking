/**
 * Vercel serverless catch-all: forwards all /api/* requests to the Express app.
 * Build backend first so backend/dist/app.js exists.
 * Ensures req.url starts with /api so Express routes match (Vercel may pass path without /api prefix).
 */
const path = require('path');
let app;
try {
  const mod = require(path.join(__dirname, '../backend/dist/app.js'));
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
