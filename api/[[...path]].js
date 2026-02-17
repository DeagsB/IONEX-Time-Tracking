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
  let pathname = (req.url && req.url.split('?')[0]) || '';
  const qs = (req.url && req.url.includes('?')) ? '?' + req.url.split('?').slice(1).join('?') : '';
  // Vercel catch-all may put path segments in req.query.path instead of req.url
  if (req.query && req.query.path !== undefined) {
    const seg = Array.isArray(req.query.path) ? req.query.path.join('/') : String(req.query.path);
    pathname = '/api/' + seg.replace(/^\/+/, '');
  } else if (pathname && !pathname.startsWith('/api')) {
    pathname = '/api' + (pathname.startsWith('/') ? pathname : '/' + pathname);
  }
  req.url = pathname + qs;
  if (req.path !== undefined) req.path = pathname;
  if (req.originalUrl !== undefined) req.originalUrl = pathname + qs;
  app(req, res);
};
module.exports = handler;
