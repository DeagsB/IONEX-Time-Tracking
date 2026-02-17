/**
 * Minimal API route when Root Directory = backend.
 * GET /api/ping -> { "ok": true, "source": "api" }
 */
module.exports = (req, res) => {
  res.status(200).json({ ok: true, source: 'api', path: req.url });
};
