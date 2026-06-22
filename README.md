# robotstxtProxy

**[→ Project website](https://vorticoncmdr.github.io/robotstxtProxy/)** — screenshots, full feature walkthrough, configuration reference.

A small Node.js **forward HTTP(S) proxy** that allows or blocks every request based on the
target origin's `robots.txt`. Point a browser (or any HTTP client) at it and it will silently
absorb blocked sub-resources (scripts, images, fonts …) without breaking page rendering, while
surfacing everything in a built-in live dashboard.

The robots.txt rule matching is done by Google's reference parser, ported to JS:
[`google-robotstxt-parser`](https://github.com/VorticonCmdr/google-robotstxt-parser). The
proxy itself has no other runtime dependency — everything else is Node built-ins.

## How it works

| Traffic | What the proxy sees | Filtering |
|---|---|---|
| **Plain HTTP** | full URL + path | full path-based robots.txt rules |
| **HTTPS `host-only`** (default) | hostname only (encrypted) | host-level only — site blocked if robots.txt disallows `/` |
| **HTTPS `mitm`** | full URL + path (after TLS interception) | full path-based rules, same as HTTP |

For each request the proxy fetches `<origin>/robots.txt` (cached, 1 h TTL), then asks the
parser whether the URL is allowed for the request's `User-Agent`.

**Fail behaviour** (when robots.txt can't be read):  
`2xx` → apply the rules · `4xx` → allow (no restrictions) · `5xx` / timeout / network error → block.

## Quick start

```bash
npm install
npm start       # listens on :8080, host-only HTTPS, smart block mode
npm test        # 31 node:test cases
```

```bash
# use as a proxy
curl -x http://localhost:8080 http://example.com/
curl -x http://localhost:8080 https://example.com/

# open the live block log
open http://localhost:8080/_proxy/
```

Configure your browser's HTTP **and** HTTPS proxy to `localhost:8080`.

## Smart block responses

When a request is blocked the proxy picks the **least disruptive response** based on the
`Sec-Fetch-Dest` header that modern browsers attach to every sub-resource request.  
This avoids broken-image icons, JS error-handler fires, and CSS parse errors on pages whose
sub-resources are partly disallowed.

| Resource type (`Sec-Fetch-Dest`) | Blocked response | Why |
|---|---|---|
| `document`, `iframe` | `403` HTML page | user navigated here — they should see it |
| `script`, `worker` | `200` empty JS `// blocked` | no `net::ERR_FAILED`, no error handler fires |
| `style` | `200` empty CSS `/* blocked */` | no devtools parse error |
| `image` | `200` 1×1 transparent GIF | no broken-image icon |
| `fetch`, `xhr` | `200` `{}` JSON | JS receives an empty-but-valid response |
| `font`, `audio`, `video`, `embed` | `204 No Content` | silently ignored |

For clients that don't send `Sec-Fetch-Dest` (CLI tools, old browsers) the proxy falls back
to sniffing the URL extension (`.js`, `.css`, `.png`, `.woff2`, …).

Set `BLOCK_MODE=403` to revert to always returning a plain-text 403, or `BLOCK_MODE=204` for
always-silent No Content.

### Finding blocked requests in browser DevTools

Every blocked response carries three headers regardless of its status code or content type:

```
X-Robots-Blocked: true
X-Robots-Txt-Reason: robots-disallow
X-Robots-Txt-Line: 3
```

Filter the Network panel to show only blocked requests:

| Browser | Filter expression |
|---|---|
| **Chrome / Edge** | `has-response-header:X-Robots-Blocked` |
| **Firefox** | type `X-Robots-Blocked` in the filter box |
| **Safari** | add a Response Headers column, filter by `X-Robots-Blocked` |

Click any matching row → Response Headers to see the reason and the matched robots.txt line.

## Dashboard

A self-contained web dashboard is available at `http://<proxy-host>:<port>/_proxy/` with no
extra setup required. It has two tabs:

**Block Log** — live-updating table of every blocked request via EventSource. Each row
includes: timestamp · method · full URL · resource type · robots.txt reason · matched line ·
Referer · client IP. Rows are prepended in real time and color-coded by resource type.

**robots.txt Cache** — inspect, add, edit, and delete cached robots.txt entries per origin.
Columns show policy (parse / allow / block), time until expiry, effective TTL, and whether
the entry was fetched from the origin or manually overridden. Actions:

- **View** — read-only modal with the full cached robots.txt body
- **Edit** — overrides the body for an origin without a network fetch
- **Delete** — evicts an entry so the next request re-fetches it live
- **Add override** — pins custom robots.txt rules for any origin

```
/_proxy/           HTML dashboard (Block Log + robots.txt Cache tabs)
/_proxy/events     SSE stream     — one JSON event per block, real-time
/_proxy/log.json   JSON snapshot  — ring buffer of the last 1000 blocks
/_proxy/cache.json JSON snapshot  — all cached origins with TTL and body
/_proxy/cache      PUT / DELETE   — create/update or evict a cache entry
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | listen address |
| `HTTPS_MODE` | `host-only` | `host-only` or `mitm` |
| `BLOCK_MODE` | `smart` | `smart` · `403` · `204` — see above |
| `ROBOTS_UA` | _(client UA)_ | fixed user-agent to match instead of the client's own |
| `CACHE_TTL_MS` | `86400000` | robots.txt cache ceiling (ms); actual TTL may be shorter if the origin returns `Cache-Control: max-age` |
| `CACHE_MAX` | `1000` | max cached origins |
| `ROBOTS_TIMEOUT_MS` | `5000` | robots.txt fetch timeout (ms) |
| `CA_CERT_PATH` | `certs/ca.crt` | MITM CA certificate (auto-generated on first run) |
| `CA_KEY_PATH` | `certs/ca.key` | MITM CA private key |
| `LOG_LEVEL` | `info` | `error` · `warn` · `info` · `debug` |

## Full HTTPS path filtering (`mitm` mode)

`host-only` mode cannot enforce path rules on HTTPS because the path is encrypted. In `mitm`
mode the proxy terminates TLS with a locally generated CA, inspects the full URL+path, and
re-encrypts to the origin — so all `BLOCK_MODE` options apply to HTTPS too.

```bash
HTTPS_MODE=mitm npm start
```

On first run a CA is generated at `certs/ca.crt` + `certs/ca.key`. **Trust `certs/ca.crt`
in the browser/OS that uses the proxy**, otherwise HTTPS sites will show certificate errors:

- **Firefox:** Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import → `ca.crt` → trust for websites
- **macOS:** `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db certs/ca.crt`
- **Linux (Debian/Ubuntu):** copy to `/usr/local/share/ca-certificates/robotstxt-proxy.crt` then `sudo update-ca-certificates`
- **Chrome/Edge on macOS/Windows:** trusting the OS keychain is enough; no browser-specific step needed

> The CA private key (`certs/ca.key`) can mint a certificate for any site — keep `certs/`
> private, never commit it (gitignored), and only trust the CA on devices you control.

`node-forge` is an optional dependency loaded only when `HTTPS_MODE=mitm` and is pre-installed
in the Docker image. If you get _"requires node-forge"_ at startup, run `npm install node-forge`.

## Docker

```bash
docker compose up --build
# or manually:
docker build -t robotstxt-proxy .
docker run -p 8080:8080 \
  -e HTTPS_MODE=host-only \
  -e BLOCK_MODE=smart \
  robotstxt-proxy
```

For `mitm` mode the compose file mounts `./certs` as a volume so the CA persists across
restarts. Trust the same `certs/ca.crt` on your clients.

## Browser container (isolated Chrome via noVNC)

Run Chrome in a Docker container that is pre-wired to the proxy — no system-wide proxy
settings on your Mac required. The container handles CA trust automatically.

```bash
docker compose -f docker-compose.browser.yml up --build
```

Then open in your Mac browser:

| URL | What you get |
|---|---|
| `http://localhost:7900` | noVNC → Chrome inside the container (proxy + CA already set up) |
| `http://localhost:8080/_proxy/` | Live block-log dashboard |

On first run the proxy generates `certs/ca.crt`. The Chrome container waits for this
file, installs it into both the system trust store and Chrome's NSS database, then
starts the browser — no manual cert-trust step needed.

**How it works:**
- `chrome/Dockerfile` extends `seleniarm/standalone-chromium` (multi-arch: ARM64 + AMD64)
  and installs `libnss3-tools` for the NSS import.
- `chrome/policy.json` is a Chrome Managed Policy that sets the proxy to
  `http://robotstxt-proxy:8080` with a bypass for `robotstxt-proxy` itself (so the
  dashboard URL resolves without looping through the proxy).
- `chrome/entrypoint.sh` waits up to 60 s for the CA cert, installs it, then calls
  the original Selenium entrypoint.
- The Chrome service `depends_on: robotstxt-proxy: condition: service_healthy`, so it
  only starts once the proxy is accepting connections.

Works on Apple Silicon and Intel Macs without any extra configuration.

## Project layout

```
src/
  server.js     entry — builds everything, wires 'request' + 'connect', graceful shutdown
  config.js     env vars → validated config object
  logger.js     tiny leveled logger (stderr, no deps)
  robots.js     RobotsCache — fetch, TTL/LRU cache, in-flight dedup, decide()
  forward.js    origin forwarding + hop-by-hop header scrubbing (RFC 7230)
  httpProxy.js  HTTP request handler: gate → smart block response or forward
                also serves /_proxy/ dashboard routes on direct hits
  connect.js    CONNECT handler — host-only tunnel or delegate to MITM
  mitm.js       optional TLS interception (lazy node-forge, CA + per-host leaf certs)
  blockLog.js   ring buffer + SSE fan-out + self-contained dashboard HTML

test/
  robots.test.js        RobotsCache: status mapping, caching, UA override
  proxy.test.js         HTTP forward allow/block, host-only CONNECT tunnel/refuse
  mitm.test.js          full MITM intercept chain, TLS + path filtering
  blockResponse.test.js smart block responses by Sec-Fetch-Dest and extension
  blockLog.test.js      ring buffer, SSE, snapshot, /_proxy/ routes
```

## Limitations / not (yet) handled

WebSocket upgrade filtering, proxy authentication, per-client policies, and honouring
robots.txt `Cache-Control` / `Crawl-delay` (a fixed TTL is used instead).
