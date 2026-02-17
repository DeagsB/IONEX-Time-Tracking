/**
 * Vercel serverless catch-all: forwards all /api/* requests to the Express app.
 * Build backend first so backend/dist/app.js exists.
 */
const path = require('path');
const app = require(path.join(__dirname, '../backend/dist/app.js')).default || require(path.join(__dirname, '../backend/dist/app.js'));
module.exports = app;
