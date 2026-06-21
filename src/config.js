// Central configuration, sourced from environment variables with documented defaults.
// Everything the rest of the app needs is resolved here once at startup.

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for ${name}: ${JSON.stringify(raw)}`);
  }
  return n;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadConfig(env = process.env) {
  const previous = process.env;
  process.env = env; // allow int()/str() helpers to read from the supplied env
  try {
    const httpsMode = str('HTTPS_MODE', 'host-only');
    if (httpsMode !== 'host-only' && httpsMode !== 'mitm') {
      throw new Error(`HTTPS_MODE must be "host-only" or "mitm", got ${JSON.stringify(httpsMode)}`);
    }

    const blockMode = str('BLOCK_MODE', 'smart');
    if (blockMode !== 'smart' && blockMode !== '403' && blockMode !== '204') {
      throw new Error(`BLOCK_MODE must be "smart", "403", or "204", got ${JSON.stringify(blockMode)}`);
    }

    return {
      port: int('PORT', 8080),
      host: str('HOST', '0.0.0.0'),
      httpsMode,
      blockMode,
      // Fixed UA override; when unset we use the request's own User-Agent.
      robotsUa: str('ROBOTS_UA', null),
      cacheTtlMs: int('CACHE_TTL_MS', 86_400_000),
      cacheMax: int('CACHE_MAX', 1000),
      robotsTimeoutMs: int('ROBOTS_TIMEOUT_MS', 5000),
      caCertPath: str('CA_CERT_PATH', 'certs/ca.crt'),
      caKeyPath: str('CA_KEY_PATH', 'certs/ca.key'),
      logLevel: str('LOG_LEVEL', 'info'),
    };
  } finally {
    process.env = previous;
  }
}
