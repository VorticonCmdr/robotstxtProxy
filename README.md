# robotstxtProxy

A small Node.js **forward HTTP(S) proxy** that allows or blocks every request based on the
target origin's `robots.txt`. Point a browser (or any HTTP client) at it and traffic to
paths a site disallows is refused with `403`.

The robots.txt rule matching is done by Google's reference parser, ported to JS:
[`google-robotstxt-parser`](https://github.com/VorticonCmdr/google-robotstxt-parser). The
proxy itself is dependency-light — everything else is Node built-ins.

## How it works

| Traffic | What the proxy sees | Filtering |
|---|---|---|
| **Plain HTTP** | full URL + path | full path-based robots.txt rules |
| **HTTPS, `host-only`** (default) | hostname only (encrypted) | host-level only — a site is blocked if its robots.txt disallows `/` |
| **HTTPS, `mitm`** | full URL + path (after TLS interception) | full path-based rules, same as HTTP |

For each request the proxy fetches `<origin>/robots.txt` (cached), then asks the parser
whether the URL is allowed for the request's `User-Agent`.

**Fail behaviour** (when robots.txt can't be read):
`2xx` → apply the rules · `4xx` → allow (no restrictions) · `5xx` / timeout / network
error → block.

## Quick start

```bash
npm install
npm start                 # listens on :8080 (host-only HTTPS)
npm test                  # node:test suite
```

Use it:

```bash
curl -x http://localhost:8080 http://example.com/        # forwarded
curl -x http://localhost:8080 https://example.com/       # tunneled (host-only)
```

Configure your browser's HTTP **and** HTTPS proxy to `localhost:8080`.

## Configuration (environment variables)

| Var | Default | Description |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | listen address |
| `HTTPS_MODE` | `host-only` | `host-only` or `mitm` |
| `ROBOTS_UA` | _(client UA)_ | fixed user-agent to match instead of the client's own |
| `CACHE_TTL_MS` | `3600000` | how long a fetched robots.txt is cached (1h) |
| `CACHE_MAX` | `1000` | max number of origins cached |
| `ROBOTS_TIMEOUT_MS` | `5000` | robots.txt fetch timeout |
| `CA_CERT_PATH` | `certs/ca.crt` | MITM CA certificate path |
| `CA_KEY_PATH` | `certs/ca.key` | MITM CA private key path |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |

## Full HTTPS filtering (`mitm` mode)

`host-only` mode cannot enforce path rules on HTTPS because the path is encrypted. To apply
full path-based rules to HTTPS, run in `mitm` mode — the proxy terminates TLS using a
locally generated CA, inspects the request, and re-encrypts to the origin.

```bash
HTTPS_MODE=mitm npm start
```

On first run it generates a CA at `certs/ca.crt` (+ `certs/ca.key`). **You must trust
`certs/ca.crt`** in the browser/OS that uses the proxy, otherwise HTTPS sites will show
certificate errors:

- **Firefox:** Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import → select `ca.crt` → trust for websites.
- **macOS:** `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db certs/ca.crt`
- **Linux (Debian/Ubuntu):** copy to `/usr/local/share/ca-certificates/robotstxt-proxy.crt` then `sudo update-ca-certificates`.

> The CA private key can mint a certificate for any site. Keep `certs/` private; never
> commit it (it's gitignored) and only trust the CA on machines you control.

`requires the optional dependency "node-forge"` on startup means MITM needs it installed
(`npm install node-forge`); it ships as an optional dependency and is included in the Docker
image.

## Docker

```bash
docker compose up --build
# or
docker build -t robotstxt-proxy .
docker run -p 8080:8080 -e HTTPS_MODE=host-only robotstxt-proxy
```

For `mitm` mode, the compose file mounts `./certs` so the generated CA persists across
restarts (trust the same `certs/ca.crt` on your clients).

## Project layout

```
src/
  server.js     entry — http.Server wiring 'request' + 'connect'
  config.js     env -> config
  logger.js     tiny leveled logger
  robots.js     RobotsCache: fetch + cache + decide(url, ua)
  forward.js    origin forwarding + hop-by-hop header scrubbing
  httpProxy.js  request handler (gate -> forward), reused by HTTP and MITM
  connect.js    CONNECT handler (host-only tunnel)
  mitm.js       optional TLS interception (lazy node-forge)
test/           node:test unit + integration tests
```

## Limitations / not (yet) handled

WebSocket upgrade filtering, proxy authentication, per-client policies, and honouring
robots.txt `Cache-Control` / `Crawl-delay` (a fixed TTL is used instead).
