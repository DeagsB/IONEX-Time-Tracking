/**
 * Minimal API route to verify /api/* is handled by serverless functions.
 * GET /api/ping -> { "ok": true, "source": "api" }
 */
module.exports = (req, res) => {
  res.status(200).json({ ok: true, source: 'api', path: req.url });
};
