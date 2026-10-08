// Minimal in-memory fixed-window limiter (single API process). Keyed by IP plus an optional
// per-request key such as the target email, so one account can't be hammered from many IPs
// without also tripping the per-IP limit.
function rateLimit({ windowMs, max, keyFn }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = `${req.ip}|${keyFn ? keyFn(req) : ''}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    next();
  };
}

module.exports = { rateLimit };
