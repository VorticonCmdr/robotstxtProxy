// Request handler for the forward proxy. Resolves the target URL, gates it through the
// robots.txt decision, and either blocks or forwards to the origin.
//
// Two proxy modes:
//   - 'proxy'     : main HTTP server; clients send absolute-form URLs.
//   - 'intercept' : MITM interception HTTPS server; request lines are origin-form.
//
// Block response modes (BLOCK_MODE env):
//   - 'smart' : resource-aware response chosen by Sec-Fetch-Dest + extension fallback.
//   - '403'   : always plain-text 403 (strict).
//   - '204'   : always 204 No Content (silent).
import { forwardToOrigin } from './forward.js';

// 1×1 transparent GIF — 35-byte constant, avoids broken-image icons for blocked images.
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

// Extension -> resource category, for clients that don't send Sec-Fetch-Dest.
const EXT_MAP = {
  js: 'script', mjs: 'script', cjs: 'script',
  css: 'style',
  gif: 'image', png: 'image', jpg: 'image', jpeg: 'image',
  webp: 'image', avif: 'image', svg: 'image', ico: 'image',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font',
  json: 'fetch', jsonld: 'fetch',
  mp4: 'video', webm: 'video', ogg: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio',
};

function detectDest(req, targetUrl) {
  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest;
  try {
    const ext = new URL(targetUrl).pathname.split('.').pop().toLowerCase();
    return EXT_MAP[ext] || 'empty';
  } catch {
    return 'empty';
  }
}

function blockResponse(req, res, targetUrl, decision, blockMode) {
  if (blockMode === '403') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(blockText(targetUrl, decision));
  }
  if (blockMode === '204') {
    res.writeHead(204);
    return res.end();
  }

  // smart mode
  const dest = detectDest(req, targetUrl);
  switch (dest) {
    case 'document':
    case 'iframe':
    case 'frame':
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(blockHtml(targetUrl, decision));

    case 'script':
    case 'worker':
    case 'sharedworker':
    case 'serviceworker':
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      return res.end('// blocked by robots.txt\n');

    case 'style':
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      return res.end('/* blocked by robots.txt */\n');

    case 'image':
      res.writeHead(200, { 'content-type': 'image/gif', 'content-length': TRANSPARENT_GIF.length });
      return res.end(TRANSPARENT_GIF);

    case 'fetch':
    case 'xhr':
    case 'manifest':
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end('{}\n');

    default:
      // font, audio, video, embed, object, empty, prefetch, preload, unknown
      res.writeHead(204);
      return res.end();
  }
}

function blockText(targetUrl, decision) {
  const line = decision.line ? ` (robots.txt line ${decision.line})` : '';
  return `Blocked by robots.txt${line}.\n\nThe origin's robots.txt disallows access to:\n  ${targetUrl}\n`;
}

function blockHtml(targetUrl, decision) {
  const line = decision.line ? `<p>Matched rule on line <strong>${decision.line}</strong> of the origin's robots.txt.</p>` : '';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Blocked by robots.txt</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:600px;margin:4rem auto;padding:0 1rem;color:#222}
    h1{color:#c00;border-bottom:1px solid #eee;padding-bottom:.5rem}
    code{background:#f5f5f5;padding:.1em .4em;border-radius:3px;font-size:.95em;word-break:break-all}
    .reason{color:#666;font-size:.9em}
  </style>
</head>
<body>
  <h1>Blocked by robots.txt</h1>
  <p>This proxy blocked access to:</p>
  <p><code>${esc(targetUrl)}</code></p>
  ${line}
  <p class="reason">Reason: <code>${esc(decision.reason)}</code> &mdash; powered by <a href="/_proxy/">robotstxt-proxy</a></p>
</body>
</html>
`;
}

// /_proxy/ dashboard routes — served when the proxy is hit directly (not used as a proxy).
function serveDashboard(req, res, blockLog) {
  const url = req.url;

  if (url === '/_proxy/' || url === '/_proxy') {
    if (!blockLog) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('Dashboard not available (blockLog not configured)\n');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(blockLog.htmlDashboard());
  }

  if (url === '/_proxy/events') {
    if (!blockLog) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('Log not available\n');
    }
    blockLog.subscribe(res);
    return;
  }

  if (url === '/_proxy/log.json') {
    const events = blockLog ? blockLog.snapshot() : [];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(events, null, 2) + '\n');
  }

  return false; // not a dashboard route
}

export function createRequestHandler({ robots, config, logger, blockLog, mode = 'proxy' }) {
  const blockMode = config?.blockMode ?? 'smart';

  return async function handleRequest(req, res) {
    let targetUrl;

    if (/^https?:\/\//i.test(req.url)) {
      targetUrl = req.url;
      // When the browser routes /_proxy/* through the proxy (absolute-form request
      // aimed at the proxy's own address), intercept and serve the dashboard directly
      // instead of trying to forward to ourselves.
      if (config) {
        try {
          const u = new URL(targetUrl);
          const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
          const effectivePort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
          if (isLoopback && effectivePort === config.port &&
              (u.pathname === '/' || u.pathname.startsWith('/_proxy'))) {
            req.url = u.pathname + u.search;
            const handled = serveDashboard(req, res, blockLog);
            if (handled !== false) return;
          }
        } catch { /* malformed URL, fall through to normal handling */ }
      }
    } else if (mode === 'intercept') {
      const host = req.headers.host;
      if (!host) return badRequest(res, 'Missing Host header');
      targetUrl = `https://${host}${req.url}`;
    } else {
      // Direct hit on the proxy port.
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('robotstxt-proxy: OK\n');
      }
      if (req.url === '/' || req.url.startsWith('/_proxy')) {
        const handled = serveDashboard(req, res, blockLog);
        if (handled !== false) return;
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
      blockLog?.record({
        ts: Date.now(),
        method: req.method,
        url: targetUrl,
        origin: (() => { try { return new URL(targetUrl).origin; } catch { return targetUrl; } })(),
        reason: decision.reason,
        line: decision.line,
        dest: detectDest(req, targetUrl),
        ua: req.headers['user-agent'] || null,
        referer: req.headers['referer'] || req.headers['referrer'] || null,
        clientIp: req.socket?.remoteAddress || null,
      });
      return blockResponse(req, res, targetUrl, decision, blockMode);
    }

    forwardToOrigin(targetUrl, req, res, { logger });
  };
}

function badRequest(res, msg) {
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${msg}\n`);
}
