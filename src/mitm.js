// MITM TLS interception for full path-based robots.txt filtering over HTTPS.
//
// On CONNECT we answer "200 Connection Established", then route the client socket into an
// internal HTTPS server. That server presents a per-host certificate signed by a local CA
// (which the user must trust in their browser/OS), decrypts the request, and runs it
// through the same robots.txt gate + forwarding logic as plain HTTP.
//
// node-forge is an *optional* dependency, imported lazily so host-only mode never needs it.
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequestHandler } from './httpProxy.js';
import { splitHostPort } from './connect.js';

export async function createMitm({ robots, config, logger }) {
  let forge;
  try {
    forge = (await import('node-forge')).default;
  } catch {
    throw new Error(
      'HTTPS_MODE=mitm requires the optional dependency "node-forge". Install it with: npm install node-forge',
    );
  }

  const ca = loadOrCreateCA(forge, config, logger);

  // One shared leaf key pair for all hosts; only the certificate varies per host.
  // Signing is cheap, key generation is not — so we generate the key once.
  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafKeyPem = forge.pki.privateKeyToPem(leafKeys.privateKey);

  /** @type {Map<string, string>} host -> cert PEM */
  const certCache = new Map();

  function getCertForHost(host) {
    let certPem = certCache.get(host);
    if (!certPem) {
      certPem = makeHostCertPem(forge, ca, leafKeys.publicKey, host);
      certCache.set(host, certPem);
    }
    return { key: leafKeyPem, cert: certPem };
  }

  const requestHandler = createRequestHandler({ robots, logger, mode: 'intercept' });

  const fallback = getCertForHost('localhost');
  const interceptServer = https.createServer(
    {
      key: fallback.key,
      cert: fallback.cert,
      SNICallback: (servername, cb) => {
        try {
          const { key, cert } = getCertForHost(servername);
          cb(null, tls.createSecureContext({ key, cert }));
        } catch (err) {
          logger?.error('SNI cert error', { servername, error: err.message });
          cb(err);
        }
      },
    },
    requestHandler,
  );

  interceptServer.on('clientError', (err, socket) => {
    logger?.debug('intercept clientError', { error: err.message });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  function handleConnect(req, clientSocket, head) {
    clientSocket.on('error', (err) => logger?.debug('mitm client socket error', { error: err.message }));
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Re-queue any bytes already read past the CONNECT line so the TLS handshake sees them.
    if (head && head.length) clientSocket.unshift(head);
    interceptServer.emit('connection', clientSocket);
  }

  logger?.info('mitm enabled', { caCert: config.caCertPath });
  return { handleConnect, caCertPath: config.caCertPath };
}

function loadOrCreateCA(forge, config, logger) {
  const { caCertPath, caKeyPath } = config;
  if (fs.existsSync(caCertPath) && fs.existsSync(caKeyPath)) {
    const certPem = fs.readFileSync(caCertPath, 'utf8');
    const keyPem = fs.readFileSync(caKeyPath, 'utf8');
    logger?.info('loaded existing CA', { caCertPath });
    return {
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
      certPem,
    };
  }

  logger?.warn('generating new CA — trust this cert in your browser/OS', { caCertPath });
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  setValidity(cert, 10); // CA valid for ~10 years
  const attrs = [
    { name: 'commonName', value: 'robotstxt-proxy CA' },
    { name: 'organizationName', value: 'robotstxt-proxy' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  fs.mkdirSync(path.dirname(caCertPath), { recursive: true });
  fs.mkdirSync(path.dirname(caKeyPath), { recursive: true });
  fs.writeFileSync(caCertPath, certPem);
  fs.writeFileSync(caKeyPath, keyPem, { mode: 0o600 });
  return { cert, key: keys.privateKey, certPem };
}

function makeHostCertPem(forge, ca, leafPublicKey, host) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = leafPublicKey;
  cert.serialNumber = randomSerial();
  setValidity(cert, 1); // leaf valid ~1 year
  cert.setSubject([{ name: 'commonName', value: host }]);
  cert.setIssuer(ca.cert.subject.attributes);

  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [isIp ? { type: 7, ip: host } : { type: 2, value: host }],
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

function setValidity(cert, years) {
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + years);
  cert.validity.notAfter = end;
}

function randomSerial() {
  // Positive hex serial; leading byte < 0x80 to keep it positive in ASN.1.
  return '00' + crypto.randomBytes(8).toString('hex');
}

export { splitHostPort };
