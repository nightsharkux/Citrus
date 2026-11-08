'use strict';
/** Response hardening and CSRF protection. */

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function applySecurityHeaders(res, { secure }) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(self), payment=()');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/**
 * Reject cross-site state-changing browser requests. Browsers always send
 * Origin on cross-origin POST/PATCH/DELETE; `Sec-Fetch-Site` covers the rest.
 * Signed device requests are exempt (they are not cookie-authenticated).
 */
function isCrossSite(req, allowedOrigins = []) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.host === req.headers.host) return false;
      // Behind some proxies/tunnels the Host header is rewritten; the configured address is the trusted origin.
      return !allowedOrigins.includes(url.origin);
    } catch {
      return true;
    }
  }
  return req.headers['sec-fetch-site'] === 'cross-site';
}

/**
 * The visitor's IP address. Behind a reverse proxy (TRUST_PROXY=1) the socket
 * address is the proxy itself, so use the address the proxy appended last to
 * X-Forwarded-For — earlier entries can be forged by the client.
 */
function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || '';
}

module.exports = { applySecurityHeaders, isCrossSite, clientIp, CONTENT_SECURITY_POLICY };
