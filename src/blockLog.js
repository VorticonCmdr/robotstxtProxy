// BlockLog: in-memory ring buffer of blocked requests + SSE fan-out for the live dashboard.
//
// No dependencies — SSE is plain text/event-stream over a keep-alive HTTP response.

export class BlockLog {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEvents=1000]   ring buffer size
   * @param {number} [opts.pingIntervalMs=30000]  SSE keep-alive ping interval
   */
  constructor({ maxEvents = 1000, pingIntervalMs = 30_000 } = {}) {
    this.maxEvents = maxEvents;
    this.pingIntervalMs = pingIntervalMs;
    /** @type {Array<object>} */
    this.events = [];
    /** @type {Set<{res: object, timer: NodeJS.Timeout}>} */
    this.subscribers = new Set();
  }

  /** Push a block event to the ring buffer and fan out to SSE subscribers. */
  record(event) {
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
    const data = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const sub of this.subscribers) {
      try { sub.res.write(data); } catch { /* subscriber gone */ }
    }
  }

  /** Subscribe an HTTP response to the SSE stream. Cleans up on close. */
  subscribe(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no', // disable nginx buffering if behind a reverse proxy
    });
    res.flushHeaders?.();

    // Send buffered events so a newly opened dashboard is immediately populated.
    if (this.events.length) {
      for (const ev of this.events) {
        res.write('data: ' + JSON.stringify(ev) + '\n\n');
      }
    }

    const timer = setInterval(() => {
      try { res.write('event: ping\ndata: {}\n\n'); } catch { cleanup(); }
    }, this.pingIntervalMs);

    const sub = { res, timer };
    this.subscribers.add(sub);

    const cleanup = () => {
      clearInterval(timer);
      this.subscribers.delete(sub);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  /** Return a copy of the ring buffer (newest last). */
  snapshot() {
    return [...this.events];
  }

  /** Destroy all SSE subscribers and clear state (used in tests). */
  destroy() {
    for (const sub of this.subscribers) {
      clearInterval(sub.timer);
      try { sub.res.destroy(); } catch { /* already gone */ }
    }
    this.subscribers.clear();
    this.events = [];
  }

  /** Self-contained HTML dashboard served at /_proxy/. */
  htmlDashboard() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>robotstxt-proxy — block log</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;margin:0;background:#f8f8f8;color:#222}
header{background:#1a1a2e;color:#fff;padding:.75rem 1.5rem;display:flex;align-items:center;gap:1.5rem}
header h1{margin:0;font-size:1.1rem;letter-spacing:.02em}
#stats{display:flex;gap:1rem;font-size:.85rem;opacity:.85}
.stat{background:rgba(255,255,255,.12);border-radius:4px;padding:.2em .7em}
#toolbar{padding:.6rem 1.5rem;display:flex;gap:.5rem;align-items:center;border-bottom:1px solid #e0e0e0;background:#fff}
#toolbar button{padding:.3em .9em;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:.85rem;background:#fff}
#toolbar button:hover{background:#f0f0f0}
#indicator{width:10px;height:10px;border-radius:50%;background:#ccc;margin-left:auto;flex-shrink:0}
#indicator.connected{background:#22c55e}
#indicator.error{background:#ef4444}
.wrap{overflow-x:auto;padding:1rem 1.5rem}
table{width:100%;border-collapse:collapse;font-size:.83rem;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.07);border-radius:6px;overflow:hidden}
th{background:#1a1a2e;color:#fff;text-align:left;padding:.5rem .75rem;font-weight:500;position:sticky;top:0;z-index:1}
td{padding:.45rem .75rem;border-bottom:1px solid #f0f0f0;vertical-align:top;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:hover td{background:#fafafa}
.url{font-family:monospace;font-size:.78rem}
.badge{display:inline-block;padding:.15em .55em;border-radius:3px;font-size:.75rem;font-weight:600;color:#fff}
.b-script{background:#7c3aed}
.b-style{background:#0891b2}
.b-image{background:#16a34a}
.b-document{background:#dc2626}
.b-iframe{background:#dc2626}
.b-font{background:#78716c}
.b-fetch,.b-xhr{background:#d97706}
.b-manifest{background:#d97706}
.b-connect{background:#1d4ed8}
.b-audio,.b-video{background:#0f766e}
.b-other{background:#6b7280}
.reason{color:#888;font-size:.75rem}
#empty{text-align:center;color:#aaa;padding:3rem;display:none}
</style>
</head>
<body>
<header>
  <h1>robotstxt-proxy &mdash; block log</h1>
  <div id="stats">
    <span class="stat" id="s-total">0 blocked</span>
    <span class="stat" id="s-origins">0 origins</span>
  </div>
</header>
<div id="toolbar">
  <button onclick="clearRows()">Clear display</button>
  <button onclick="location.href='/_proxy/log.json'">Download JSON</button>
  <span id="indicator" title="SSE connection status"></span>
</div>
<div class="wrap">
<table id="log">
  <thead><tr>
    <th>Time</th>
    <th>Method</th>
    <th style="min-width:220px">URL</th>
    <th>Type</th>
    <th>Reason</th>
    <th>Line</th>
    <th style="min-width:140px">Referer</th>
    <th>Client IP</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table>
<p id="empty">No blocked requests yet.</p>
</div>
<script>
const MAX_ROWS = 500;
let totalBlocked = 0;
const origins = new Set();
const tbody = document.getElementById('tbody');
const ind = document.getElementById('indicator');

function esc(s){return s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function destClass(d){
  const known=['script','style','image','document','iframe','font','fetch','xhr','manifest','connect','audio','video'];
  return known.includes(d)?'b-'+d:'b-other';
}

function pad(n){return String(n).padStart(2,'0')}
function fmtTime(ts){
  const d=new Date(ts);
  return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
}

function addRow(ev){
  totalBlocked++;
  if(ev.origin)origins.add(ev.origin);
  document.getElementById('s-total').textContent=totalBlocked+' blocked';
  document.getElementById('s-origins').textContent=origins.size+' origin'+(origins.size===1?'':'s');
  document.getElementById('empty').style.display='none';

  const tr=document.createElement('tr');
  const dest=ev.dest||'?';
  tr.innerHTML=
    '<td>'+esc(fmtTime(ev.ts))+'</td>'+
    '<td>'+esc(ev.method)+'</td>'+
    '<td class="url" title="'+esc(ev.url)+'">'+esc(ev.url)+'</td>'+
    '<td><span class="badge '+destClass(dest)+'">'+esc(dest)+'</span></td>'+
    '<td class="reason">'+esc(ev.reason)+'</td>'+
    '<td>'+(ev.line||'')+'</td>'+
    '<td class="url" title="'+esc(ev.referer)+'">'+esc(ev.referer||'')+'</td>'+
    '<td>'+esc(ev.clientIp||'')+'</td>';
  tbody.prepend(tr);
  // trim DOM
  while(tbody.children.length>MAX_ROWS)tbody.lastChild.remove();
}

function clearRows(){tbody.innerHTML='';document.getElementById('empty').style.display='none';}

function connect(){
  const es=new EventSource('/_proxy/events');
  es.onopen=()=>ind.className='connected';
  es.onerror=()=>ind.className='error';
  es.onmessage=e=>{try{addRow(JSON.parse(e.data))}catch{}};
}
connect();

// Show empty state if no events arrive in first 2s
setTimeout(()=>{if(!totalBlocked)document.getElementById('empty').style.display='block'},2000);
</script>
</body>
</html>
`;
  }
}
