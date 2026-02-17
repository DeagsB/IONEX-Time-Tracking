/**
 * Vercel serverless catch-all: forwards all /api/* requests to the Express app.
 * Build backend first so backend/dist/app.js exists.
 * Wrapped so load failures return 500 instead of FUNCTION_INVOCATION_FAILED.
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
module.exports = app;
