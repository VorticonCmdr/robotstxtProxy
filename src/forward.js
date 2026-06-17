// Shared origin forwarding for both the plain-HTTP proxy and the MITM interception server.
// Streams the inbound request to the origin and the origin's response back to the client,
// stripping hop-by-hop headers in both directions (RFC 7230 §6.1).
import http from 'node:http';
import https from 'node:https';

// Headers that are connection-specific and must not be forwarded end-to-end.
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

function scrubHeaders(headers) {
  const out = {};
  // Any token named in the Connection header is also hop-by-hop for this message.
  const connectionTokens = new Set(
    String(headers.connection || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Forward an inbound proxy request to its origin and pipe the response back.
 * @param {string} targetUrl  absolute URL of the origin resource
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} [opts]
 * @param {object} [opts.logger]
 */
export function forwardToOrigin(targetUrl, req, res, { logger } = {}) {
  const url = new URL(targetUrl);
  const transport = url.protocol === 'https:' ? https : http;

  const headers = scrubHeaders(req.headers);
  // Ensure the Host header matches the origin we are actually contacting.
  headers.host = url.host;

  const upstream = transport.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: url.pathname + url.search,
      headers,
    },
    (originRes) => {
      res.writeHead(originRes.statusCode, scrubHeaders(originRes.headers));
      originRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    logger?.warn('upstream error', { target: targetUrl, error: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Bad gateway: ${err.message}\n`);
    } else {
      res.destroy();
    }
  });

  req.pipe(upstream);
}
