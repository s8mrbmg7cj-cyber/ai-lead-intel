// /lib/rate-limit.js
//
// Tiny in-memory rate limiter — no external deps.
//
// Trade-offs:
//   ✅ Zero infra, zero cost
//   ✅ Works fine for normal traffic on warm Vercel functions
//   ⚠️ Resets on cold start (single instance)
//   ⚠️ Each Vercel region has its own memory
//
// For a pre-paying-customer SaaS this is the right call. Upgrade to KV/Redis
// when you have >100 customers or get hit by a real attack.
//
// Usage:
//   import { rateLimit, getClientIp } from '../lib/rate-limit.js';
//   const ip = getClientIp(req);
//   const limit = rateLimit('login:' + ip, 5, 60 * 10); // 5 in 10 minutes
//   if (!limit.ok) {
//     res.setHeader('Retry-After', limit.retryAfter);
//     return res.status(429).json({ success: false, error: 'Too many requests' });
//   }

const buckets = new Map(); // key -> { count, windowStart, blockedUntil }

/**
 * @param {string} key  Unique key (usually "action:ip")
 * @param {number} max  Max requests allowed in the window
 * @param {number} windowSec  Window length in seconds
 * @param {number} [blockSec]  Optional extra block duration after limit hit
 * @returns {{ok: boolean, count: number, retryAfter: number}}
 */
export function rateLimit(key, max, windowSec, blockSec = 0) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const blockMs = blockSec * 1000;

  let bucket = buckets.get(key);

  // Sweep old buckets occasionally
  if (buckets.size > 5000 && Math.random() < 0.01) {
    sweep(now);
  }

  if (!bucket) {
    bucket = { count: 0, windowStart: now, blockedUntil: 0 };
    buckets.set(key, bucket);
  }

  // If currently blocked, deny
  if (bucket.blockedUntil > now) {
    return {
      ok: false,
      count: bucket.count,
      retryAfter: Math.ceil((bucket.blockedUntil - now) / 1000),
    };
  }

  // Reset window if expired
  if (now - bucket.windowStart > windowMs) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count++;

  if (bucket.count > max) {
    // Block for blockSec (or rest of window if blockSec is 0)
    bucket.blockedUntil = now + (blockMs || (windowMs - (now - bucket.windowStart)));
    return {
      ok: false,
      count: bucket.count,
      retryAfter: Math.ceil((bucket.blockedUntil - now) / 1000),
    };
  }

  return { ok: true, count: bucket.count, retryAfter: 0 };
}

/** Extract the client IP from Vercel/standard headers. */
export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/** Periodic cleanup of stale buckets. */
function sweep(now) {
  const cutoff = now - 60 * 60 * 1000; // 1 hour
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.blockedUntil < now && bucket.windowStart < cutoff) {
      buckets.delete(key);
    }
  }
}
