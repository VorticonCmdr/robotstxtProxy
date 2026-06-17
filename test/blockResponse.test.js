import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxy } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const silent = { error() {}, warn() {}, info() {}, debug() {} };

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// Proxy that blocks everything (5xx robots.txt -> block) in smart mode.
async function startBlockingProxy(extraEnv = {}) {
  const config = loadConfig({ HTTPS_MODE: 'host-only', BLOCK_MODE: 'smart', ...extraEnv });
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '' });
  const { server, blockLog } = await createProxy({ config, fetchImpl, logger: silent });
  const port = await listen(server);
  return { server, blockLog, port };
}

function proxyReq(proxyPort, targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: { host: new URL(targetUrl).host, ...extraHeaders },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('smart mode: document -> 403 HTML page', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/page', { 'sec-fetch-dest': 'document' });
  assert.equal(r.status, 403);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.body, /robots\.txt/);
});

test('smart mode: script -> 200 empty JS', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/app.js', { 'sec-fetch-dest': 'script' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /javascript/);
  assert.match(r.body, /blocked/);
});

test('smart mode: style -> 200 empty CSS', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/main.css', { 'sec-fetch-dest': 'style' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/css/);
});

test('smart mode: image -> 200 transparent GIF', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/img.png', { 'sec-fetch-dest': 'image' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /image\/gif/);
  assert.ok(r.body.length > 0);
});

test('smart mode: fetch/XHR -> 200 empty JSON', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/api/data', { 'sec-fetch-dest': 'fetch' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/json/);
});

test('smart mode: font -> 204 No Content', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/font.woff2', { 'sec-fetch-dest': 'font' });
  assert.equal(r.status, 204);
});

test('smart mode: unknown dest -> 204 No Content', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/blob', { 'sec-fetch-dest': 'empty' });
  assert.equal(r.status, 204);
});

test('smart mode: no Sec-Fetch-Dest, .js extension -> 200 JS', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/bundle.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /javascript/);
});

test('smart mode: no Sec-Fetch-Dest, .png extension -> 200 GIF', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/photo.png');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /image\/gif/);
});

test('smart mode: no Sec-Fetch-Dest, no known extension -> 204', async (t) => {
  const { server, port } = await startBlockingProxy();
  t.after(() => server.close());
  const r = await proxyReq(port, 'http://x.test/unknown-resource');
  assert.equal(r.status, 204);
});

test('BLOCK_MODE=403 always returns 403 text/plain regardless of dest', async (t) => {
  const { server, port } = await startBlockingProxy({ BLOCK_MODE: '403' });
  t.after(() => server.close());
  const script = await proxyReq(port, 'http://x.test/app.js', { 'sec-fetch-dest': 'script' });
  assert.equal(script.status, 403);
  assert.match(script.headers['content-type'], /text\/plain/);
  const img = await proxyReq(port, 'http://x.test/img.png', { 'sec-fetch-dest': 'image' });
  assert.equal(img.status, 403);
});

test('BLOCK_MODE=204 always returns 204 regardless of dest', async (t) => {
  const { server, port } = await startBlockingProxy({ BLOCK_MODE: '204' });
  t.after(() => server.close());
  const doc = await proxyReq(port, 'http://x.test/page', { 'sec-fetch-dest': 'document' });
  assert.equal(doc.status, 204);
  const js = await proxyReq(port, 'http://x.test/app.js', { 'sec-fetch-dest': 'script' });
  assert.equal(js.status, 204);
});

test('all block modes set X-Robots-Blocked header for DevTools filtering', async (t) => {
  // smart — 200 JS response still carries the marker
  const { server: s1, port: p1 } = await startBlockingProxy({ BLOCK_MODE: 'smart' });
  t.after(() => s1.close());
  const js = await proxyReq(p1, 'http://x.test/app.js', { 'sec-fetch-dest': 'script' });
  assert.equal(js.headers['x-robots-blocked'], 'true');
  assert.equal(js.headers['x-robots-txt-reason'], 'robots-unavailable');

  // smart — 204 default path
  const silent204 = await proxyReq(p1, 'http://x.test/blob', { 'sec-fetch-dest': 'empty' });
  assert.equal(silent204.headers['x-robots-blocked'], 'true');

  // 403 mode
  const { server: s2, port: p2 } = await startBlockingProxy({ BLOCK_MODE: '403' });
  t.after(() => s2.close());
  const strict = await proxyReq(p2, 'http://x.test/page', { 'sec-fetch-dest': 'document' });
  assert.equal(strict.headers['x-robots-blocked'], 'true');

  // 204 mode
  const { server: s3, port: p3 } = await startBlockingProxy({ BLOCK_MODE: '204' });
  t.after(() => s3.close());
  const silent = await proxyReq(p3, 'http://x.test/page');
  assert.equal(silent.headers['x-robots-blocked'], 'true');
});

test('X-Robots-Txt-Line header present only when robots.txt line is known', async (t) => {
  // 5xx -> block-all policy: no line number
  const { server: s1, port: p1 } = await startBlockingProxy();
  t.after(() => s1.close());
  const noLine = await proxyReq(p1, 'http://x.test/page', { 'sec-fetch-dest': 'document' });
  assert.equal(noLine.headers['x-robots-txt-line'], undefined);

  // 2xx with a matching rule: line number present
  const fetchWithRule = async () => ({
    ok: true, status: 200,
    text: async () => 'User-agent: *\nDisallow: /\n',
  });
  const config = loadConfig({ HTTPS_MODE: 'host-only', BLOCK_MODE: 'smart' });
  const { createProxy } = await import('../src/server.js');
  const { server: s2 } = await createProxy({ config, fetchImpl: fetchWithRule, logger: { error(){}, warn(){}, info(){}, debug(){} } });
  s2.listen(0, '127.0.0.1');
  await once(s2, 'listening');
  const p2 = s2.address().port;
  t.after(() => s2.close());
  const withLine = await proxyReq(p2, 'http://x.test/page', { 'sec-fetch-dest': 'document' });
  assert.ok(withLine.headers['x-robots-txt-line'], 'line header should be set');
});
