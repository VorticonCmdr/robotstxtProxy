// Request handler for the forward proxy. Resolves the target URL, gates it through the
// robots.txt decision, and either blocks (403) or forwards to the origin.
//
// Reused in two modes:
//   - 'proxy'     : the main HTTP server. Clients send absolute-form request lines
//                   (GET http://host/path). A path-only request means someone hit the
//                   proxy port directly, so we serve a small info/health response.
//   - 'intercept' : the MITM interception HTTPS server. Request lines are origin-form
//                   (GET /path) and the scheme is always https.
import { forwardToOrigin } from './forward.js';

function blockPage(targetUrl, decision) {
  const line = decision.line ? ` (robots.txt line ${decision.line})` : '';
  return (
    `Blocked by robots.txt${line}.\n\n` +
    `The origin's robots.txt disallows access to:\n  ${targetUrl}\n`
  );
}

export function createRequestHandler({ robots, logger, mode = 'proxy' }) {
  return async function handleRequest(req, res) {
    let targetUrl;

    if (/^https?:\/\//i.test(req.url)) {
      targetUrl = req.url;
    } else if (mode === 'intercept') {
      const host = req.headers.host;
      if (!host) return badRequest(res, 'Missing Host header');
      targetUrl = `https://${host}${req.url}`;
    } else {
      // Direct hit on the proxy port (not used as a proxy) -> health/info.
      if (req.url === '/healthz' || req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('robotstxt-proxy: OK. Configure me as your HTTP(S) proxy.\n');
      }
      return badRequest(res, 'This is a forward proxy; send absolute-form requests.');
    }

    let decision;
    try {
      decision = await robots.decide(targetUrl, req.headers['user-agent'] || null);
    } catch (err) {
      logger?.error('decision error', { target: targetUrl, error: err.message });
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`Proxy error: ${err.message}\n`);
    }

    logger?.info(decision.allowed ? 'allow' : 'block', {
      method: req.method,
      url: targetUrl,
      reason: decision.reason,
    });

    if (!decision.allowed) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(blockPage(targetUrl, decision));
    }

    forwardToOrigin(targetUrl, req, res, { logger });
  };
}

function badRequest(res, msg) {
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${msg}\n`);
}
