import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createProxy } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const silent = { error() {}, warn() {}, info() {}, debug() {} };

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function startProxy({ fetchImpl } = {}) {
  const config = loadConfig({ HTTPS_MODE: 'host-only' });
  const { server } = await createProxy({ config, fetchImpl, logger: silent });
  const port = await listen(server);
  return { server, port };
}

// --- plain HTTP forward proxy -------------------------------------------------

function proxyGet(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl, // absolute-form request line
      headers: { host: u.host },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTTP: allowed path is proxied, disallowed path is blocked (403)', async (t) => {
  const origin = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /private/\n');
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('PAGE ' + req.url);
  });
  const originPort = await listen(origin);
  const { server: proxy, port: proxyPort } = await startProxy();
  t.after(() => {
    origin.close();
    proxy.close();
  });

  const ok = await proxyGet(proxyPort, `http://127.0.0.1:${originPort}/public`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'PAGE /public');

  const blocked = await proxyGet(proxyPort, `http://127.0.0.1:${originPort}/private/x`);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body, /robots\.txt/);
});

// --- HTTPS host-only CONNECT --------------------------------------------------

// Speaks the CONNECT handshake over a raw socket and returns the status line + socket.
function rawConnect(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx !== -1) {
        sock.removeListener('data', onData);
        resolve({ sock, statusLine: buf.slice(0, idx).toString().split('\r\n')[0] });
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

test('CONNECT host-only: allowed host tunnels raw bytes through', async (t) => {
  const echo = net.createServer((s) => s.pipe(s));
  const echoPort = await listen(echo);
  const allowFetch = async () => ({ ok: true, status: 200, text: async () => 'User-agent: *\nAllow: /\n' });
  const { server: proxy, port: proxyPort } = await startProxy({ fetchImpl: allowFetch });
  t.after(() => {
    echo.close();
    proxy.close();
  });

  const { sock, statusLine } = await rawConnect(proxyPort, `127.0.0.1:${echoPort}`);
  assert.match(statusLine, /200/);
  sock.write('ping');
  const [data] = await once(sock, 'data');
  assert.equal(data.toString(), 'ping');
  sock.destroy();
});

test('CONNECT host-only: host disallowing root is refused (403)', async (t) => {
  const blockFetch = async () => ({ ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /\n' });
  const { server: proxy, port: proxyPort } = await startProxy({ fetchImpl: blockFetch });
  t.after(() => proxy.close());

  const { sock, statusLine } = await rawConnect(proxyPort, `blocked.test:443`);
  assert.match(statusLine, /403/);
  sock.destroy();
});
