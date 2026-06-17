#!/usr/bin/env node
// Entry point: wires config, robots cache, and the request/connect handlers into a single
// http.Server that acts as a forward HTTP(S) proxy gated by robots.txt.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { RobotsCache } from './robots.js';
import { createRequestHandler } from './httpProxy.js';
import { createConnectHandler } from './connect.js';
import { createMitm } from './mitm.js';

/**
 * Build (but do not start) the proxy server. Exposed for tests.
 * @param {object} [opts]
 * @param {object} [opts.config]     override resolved config
 * @param {object} [opts.logger]
 * @param {Function} [opts.fetchImpl] inject a fetch implementation for robots.txt
 */
export async function createProxy({ config, logger, fetchImpl } = {}) {
  config = config || loadConfig();
  logger = logger || createLogger(config.logLevel);
  const robots = new RobotsCache({ config, logger, fetchImpl });

  let mitm = null;
  if (config.httpsMode === 'mitm') {
    mitm = await createMitm({ robots, config, logger });
  }

  const server = http.createServer(createRequestHandler({ robots, logger, mode: 'proxy' }));
  server.on('connect', createConnectHandler({ robots, config, logger, mitm }));

  return { server, config, logger, robots };
}

async function main() {
  const { server, config, logger } = await createProxy();
  server.listen(config.port, config.host, () => {
    logger.info('proxy listening', {
      host: config.host,
      port: config.port,
      httpsMode: config.httpsMode,
    });
  });

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
