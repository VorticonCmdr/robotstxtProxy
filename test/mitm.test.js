import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createProxy } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const silent = { error() {}, warn() {}, info() {}, debug() {} };

// node-forge is an optional dependency; skip the whole file if it isn't installed.
let hasForge = true;
try {
  await import('node-forge');
} catch {
  hasForge = false;
}

test('MITM: intercepts HTTPS and blocks a disallowed path with our trusted CA', { skip: !hasForge }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-ca-'));
  const caCertPath = path.join(tmp, 'ca.crt');
  const caKeyPath = path.join(tmp, 'ca.key');

  const blockFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => 'User-agent: *\nDisallow: /private/\n',
  });

  const config = loadConfig({
    HTTPS_MODE: 'mitm',
    BLOCK_MODE: '403',
    CA_CERT_PATH: caCertPath,
    CA_KEY_PATH: caKeyPath,
  });
  const { server: proxy } = await createProxy({ config, fetchImpl: blockFetch, logger: silent });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyPort = proxy.address().port;
  t.after(() => {
    proxy.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 1) CONNECT to the proxy (raw), get the tunnel.
  const raw = net.connect(proxyPort, '127.0.0.1');
  await once(raw, 'connect');
  raw.write('CONNECT site.test:443 HTTP/1.1\r\nHost: site.test:443\r\n\r\n');
  const [established] = await once(raw, 'data');
  assert.match(established.toString().split('\r\n')[0], /200/);

  // 2) TLS handshake over the tunnel, trusting only our generated CA.
  const caPem = fs.readFileSync(caCertPath);
  const tlsSock = tls.connect({ socket: raw, servername: 'site.test', ca: caPem });
  await once(tlsSock, 'secureConnect');
  assert.equal(tlsSock.authorized, true); // proxy cert chains to our CA

  // 3) A disallowed path is blocked before any origin contact.
  tlsSock.write('GET /private/secret HTTP/1.1\r\nHost: site.test\r\nConnection: close\r\n\r\n');
  let resp = '';
  tlsSock.on('data', (d) => (resp += d));
  await once(tlsSock, 'end');
  assert.match(resp.split('\r\n')[0], /403/);
  assert.match(resp, /robots\.txt/);
  tlsSock.destroy();
});
