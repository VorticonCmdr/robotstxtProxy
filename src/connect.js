// CONNECT handler for HTTPS traffic.
//
//   host-only mode (default): we cannot see the encrypted path, so we gate at the host
//     level — if the origin's robots.txt disallows the root ("/"), the whole host is
//     refused; otherwise we open a blind TCP tunnel. Path-level rules cannot be enforced
//     here (the traffic is end-to-end encrypted).
//
//   mitm mode: delegated to the interception server, which terminates TLS and applies
//     full path-based filtering.
import net from 'node:net';

export function splitHostPort(authority, defaultPort = 443) {
  // authority is "host:port"; host may be an IPv6 literal in brackets.
  const lastColon = authority.lastIndexOf(':');
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    const host = authority.slice(1, end);
    const port = authority.slice(end + 2) || String(defaultPort);
    return [host, Number.parseInt(port, 10)];
  }
  if (lastColon === -1) return [authority, defaultPort];
  return [authority.slice(0, lastColon), Number.parseInt(authority.slice(lastColon + 1), 10) || defaultPort];
}

export function createConnectHandler({ robots, config, logger, mitm }) {
  return async function handleConnect(req, clientSocket, head) {
    if (mitm) return mitm.handleConnect(req, clientSocket, head);

    const [host, port] = splitHostPort(req.url);

    let decision;
    try {
      decision = await robots.decide(`https://${host}/`, config.robotsUa || '*');
    } catch (err) {
      logger?.error('connect decision error', { host, error: err.message });
      decision = { allowed: false, reason: 'error' };
    }

    logger?.info(decision.allowed ? 'connect-allow' : 'connect-block', {
      host,
      port,
      reason: decision.reason,
    });

    if (!decision.allowed) {
      clientSocket.write(
        'HTTP/1.1 403 Forbidden\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n' +
          'Connection: close\r\n\r\n' +
          'Blocked by robots.txt (host-level)\r\n',
      );
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', (err) => {
      logger?.warn('tunnel upstream error', { host, port, error: err.message });
      clientSocket.destroy();
    });
    clientSocket.on('error', () => upstream.destroy());
  };
}
