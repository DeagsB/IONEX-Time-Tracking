/**
 * Vercel serverless catch-all when Root Directory = backend.
 * Forwards /api/* to the Express app (backend/dist/app.js).
 */
const app = require('../dist/app.js').default || require('../dist/app.js');
module.exports = app;
