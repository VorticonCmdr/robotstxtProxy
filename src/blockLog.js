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
<title>robotstxt-proxy — dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;margin:0;background:#f8f8f8;color:#222}
header{background:#1a1a2e;color:#fff;padding:.75rem 1.5rem;display:flex;align-items:center;gap:1.5rem}
header h1{margin:0;font-size:1.1rem;letter-spacing:.02em}
#stats{display:flex;gap:1rem;font-size:.85rem;opacity:.85}
.stat{background:rgba(255,255,255,.12);border-radius:4px;padding:.2em .7em}
nav#tabs{display:flex;border-bottom:2px solid #e0e0e0;background:#fff;padding:0 1.5rem}
.tab{padding:.55rem 1.1rem;border:none;background:none;cursor:pointer;font-size:.88rem;color:#666;border-bottom:3px solid transparent;margin-bottom:-2px;transition:color .15s}
.tab:hover{color:#222}
.tab.active{color:#1a1a2e;border-bottom-color:#1a1a2e;font-weight:600}
.toolbar{padding:.6rem 1.5rem;display:flex;gap:.5rem;align-items:center;border-bottom:1px solid #e0e0e0;background:#fff}
.toolbar button{padding:.3em .9em;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:.85rem;background:#fff}
.toolbar button:hover{background:#f0f0f0}
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
.b-script{background:#7c3aed}.b-style{background:#0891b2}.b-image{background:#16a34a}
.b-document,.b-iframe{background:#dc2626}.b-font{background:#78716c}
.b-fetch,.b-xhr,.b-manifest{background:#d97706}.b-connect{background:#1d4ed8}
.b-audio,.b-video{background:#0f766e}.b-other{background:#6b7280}
.b-parse{background:#1d4ed8}.b-allow{background:#16a34a}.b-block{background:#dc2626}
.b-fetched{background:#78716c}.b-override{background:#b45309}
.reason{color:#888;font-size:.75rem}
.act-btn{padding:.2em .6em;border:1px solid #ccc;border-radius:3px;cursor:pointer;font-size:.78rem;background:#fff;margin-right:2px}
.act-btn:hover{background:#f0f0f0}
.act-btn.del{border-color:#fca5a5;color:#dc2626}.act-btn.del:hover{background:#fef2f2}
#log-empty,#cache-empty{text-align:center;color:#aaa;padding:3rem;display:none}
dialog{border:none;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.18);padding:0;max-width:680px;width:95vw;max-height:90vh;overflow:hidden;display:flex;flex-direction:column}
dialog::backdrop{background:rgba(0,0,0,.4)}
.dlg-head{background:#1a1a2e;color:#fff;padding:.75rem 1.25rem;font-size:1rem;font-weight:600;flex-shrink:0}
.dlg-body{padding:1rem 1.25rem;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:.6rem}
.dlg-body label{font-size:.82rem;font-weight:600;color:#555;margin-bottom:.1rem}
.dlg-body input,.dlg-body textarea{width:100%;border:1px solid #d1d5db;border-radius:4px;padding:.4em .6em;font-size:.85rem;font-family:monospace}
.dlg-body textarea{resize:vertical;min-height:220px}
.dlg-body input[readonly],.dlg-body textarea[readonly]{background:#f8f8f8;color:#555}
.dlg-foot{padding:.75rem 1.25rem;display:flex;gap:.5rem;border-top:1px solid #e0e0e0;flex-shrink:0}
.dlg-foot button{padding:.35em 1em;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:.85rem;background:#fff}
.dlg-foot button.primary{background:#1a1a2e;color:#fff;border-color:#1a1a2e}
.dlg-foot button.primary:hover{background:#2d2d50}
.dlg-foot button:hover{background:#f0f0f0}
</style>
</head>
<body>
<header>
  <h1>robotstxt-proxy</h1>
  <div id="stats">
    <span class="stat" id="s-total">0 blocked</span>
    <span class="stat" id="s-origins">0 origins</span>
  </div>
</header>
<nav id="tabs">
  <button class="tab active" data-tab="log">Block Log</button>
  <button class="tab" data-tab="cache">robots.txt Cache</button>
</nav>

<!-- Block Log Panel -->
<div id="panel-log">
  <div class="toolbar">
    <button onclick="clearRows()">Clear display</button>
    <button onclick="location.href='/_proxy/log.json'">Download JSON</button>
    <span id="indicator" title="SSE connection status"></span>
  </div>
  <div class="wrap">
    <table id="log">
      <thead><tr>
        <th>Time</th><th>Method</th>
        <th style="min-width:220px">URL</th>
        <th>Type</th><th>Reason</th><th>Line</th>
        <th style="min-width:140px">Referer</th><th>Client IP</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    <p id="log-empty">No blocked requests yet.</p>
  </div>
</div>

<!-- Cache Panel -->
<div id="panel-cache" hidden>
  <div class="toolbar">
    <button onclick="loadCache()">Refresh</button>
    <button onclick="openAddDialog()">Add override</button>
  </div>
  <div class="wrap">
    <table id="cache-table">
      <thead><tr>
        <th style="min-width:200px">Origin</th>
        <th>Policy</th>
        <th>Expires in</th>
        <th>TTL</th>
        <th>Source</th>
        <th>Actions</th>
      </tr></thead>
      <tbody id="cache-tbody"></tbody>
    </table>
    <p id="cache-empty">No cached origins yet. Make a request through the proxy to populate the cache.</p>
  </div>
</div>

<!-- Cache Edit/View Dialog -->
<dialog id="cache-dialog">
  <div class="dlg-head" id="dlg-title">Edit robots.txt</div>
  <div class="dlg-body">
    <label for="dlg-origin">Origin</label>
    <input id="dlg-origin" type="text" placeholder="https://example.com">
    <label for="dlg-body">robots.txt body</label>
    <textarea id="dlg-body" placeholder="User-agent: *&#10;Disallow: /"></textarea>
  </div>
  <div class="dlg-foot">
    <button class="primary" id="dlg-save" onclick="saveDialog()">Save override</button>
    <button onclick="document.getElementById('cache-dialog').close()">Close</button>
  </div>
</dialog>

<script>
// ---- shared helpers ----
function esc(s){return s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function pad(n){return String(n).padStart(2,'0')}
function fmtTime(ts){const d=new Date(ts);return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())}
function fmtMs(ms){
  if(ms<=0)return 'expired';
  const s=Math.round(ms/1000);
  if(s<60)return s+'s';
  const m=Math.floor(s/60);
  if(m<60)return m+'m';
  const h=Math.floor(m/60);
  if(h<24)return h+'h '+(m%60)+'m';
  return Math.floor(h/24)+'d '+(h%24)+'h';
}

// ---- tab switching ----
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const tab=btn.dataset.tab;
    document.getElementById('panel-log').hidden=tab!=='log';
    document.getElementById('panel-cache').hidden=tab!=='cache';
    if(tab==='cache')loadCache();
  });
});

// ---- block log ----
const MAX_ROWS=500;
let totalBlocked=0;
const blockedOrigins=new Set();
const tbody=document.getElementById('tbody');
const ind=document.getElementById('indicator');

function destClass(d){
  const known=['script','style','image','document','iframe','font','fetch','xhr','manifest','connect','audio','video'];
  return known.includes(d)?'b-'+d:'b-other';
}
function addRow(ev){
  totalBlocked++;
  if(ev.origin)blockedOrigins.add(ev.origin);
  document.getElementById('s-total').textContent=totalBlocked+' blocked';
  document.getElementById('s-origins').textContent=blockedOrigins.size+' origin'+(blockedOrigins.size===1?'':'s');
  document.getElementById('log-empty').style.display='none';
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
  while(tbody.children.length>MAX_ROWS)tbody.lastChild.remove();
}
function clearRows(){tbody.innerHTML='';document.getElementById('log-empty').style.display='none';}
function connect(){
  const es=new EventSource('/_proxy/events');
  es.onopen=()=>ind.className='connected';
  es.onerror=()=>ind.className='error';
  es.onmessage=e=>{try{addRow(JSON.parse(e.data))}catch{}};
}
connect();
setTimeout(()=>{if(!totalBlocked)document.getElementById('log-empty').style.display='block'},2000);

// ---- cache tab ----
const cacheByOrigin=new Map();

async function loadCache(){
  try{
    const data=await fetch('/_proxy/cache.json').then(r=>r.json());
    renderCache(data);
  }catch(e){console.error('cache load failed',e);}
}

function renderCache(data){
  cacheByOrigin.clear();
  data.forEach(e=>cacheByOrigin.set(e.origin,e));
  const ctbody=document.getElementById('cache-tbody');
  const empty=document.getElementById('cache-empty');
  if(!data.length){
    ctbody.innerHTML='';
    empty.style.display='block';
    return;
  }
  empty.style.display='none';
  ctbody.innerHTML=data.map(e=>{
    const pClass=e.policy==='parse'?'b-parse':e.policy==='allow'?'b-allow':'b-block';
    const sClass=e.isOverride?'b-override':'b-fetched';
    const eo=esc(e.origin);
    return '<tr>'+
      '<td class="url" title="'+eo+'">'+eo+'</td>'+
      '<td><span class="badge '+pClass+'">'+esc(e.policy)+'</span></td>'+
      '<td>'+fmtMs(e.remainingMs)+'</td>'+
      '<td>'+fmtMs(e.ttlMs)+'</td>'+
      '<td><span class="badge '+sClass+'">'+(e.isOverride?'override':'fetched')+'</span></td>'+
      '<td>'+
        '<button class="act-btn" data-origin="'+eo+'" data-action="view">View</button>'+
        '<button class="act-btn" data-origin="'+eo+'" data-action="edit">Edit</button>'+
        '<button class="act-btn del" data-origin="'+eo+'" data-action="delete">Delete</button>'+
      '</td>'+
      '</tr>';
  }).join('');
}

document.getElementById('cache-tbody').addEventListener('click',e=>{
  const btn=e.target.closest('button[data-origin]');
  if(!btn)return;
  const origin=btn.dataset.origin;
  const entry=cacheByOrigin.get(origin);
  const action=btn.dataset.action;
  if(action==='delete')deleteEntry(origin);
  else if(action==='view'&&entry)openViewDialog(entry);
  else if(action==='edit'&&entry)openEditDialog(entry);
});

async function deleteEntry(origin){
  await fetch('/_proxy/cache?origin='+encodeURIComponent(origin),{method:'DELETE'});
  loadCache();
}

function openViewDialog(e){
  document.getElementById('dlg-title').textContent='View robots.txt — '+e.origin;
  const inp=document.getElementById('dlg-origin');
  inp.value=e.origin; inp.readOnly=true;
  const ta=document.getElementById('dlg-body');
  ta.value=e.body||('(no body — policy: '+e.policy+')');
  ta.readOnly=true;
  document.getElementById('dlg-save').style.display='none';
  document.getElementById('cache-dialog').showModal();
}

function openEditDialog(e){
  document.getElementById('dlg-title').textContent='Edit override — '+e.origin;
  const inp=document.getElementById('dlg-origin');
  inp.value=e.origin; inp.readOnly=true;
  const ta=document.getElementById('dlg-body');
  ta.value=e.body||''; ta.readOnly=false;
  document.getElementById('dlg-save').style.display='';
  document.getElementById('cache-dialog').showModal();
}

function openAddDialog(){
  document.getElementById('dlg-title').textContent='Add robots.txt override';
  const inp=document.getElementById('dlg-origin');
  inp.value=''; inp.readOnly=false;
  const ta=document.getElementById('dlg-body');
  ta.value=''; ta.readOnly=false;
  document.getElementById('dlg-save').style.display='';
  document.getElementById('cache-dialog').showModal();
}

async function saveDialog(){
  const origin=document.getElementById('dlg-origin').value.trim();
  const body=document.getElementById('dlg-body').value;
  if(!origin)return;
  await fetch('/_proxy/cache',{
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({origin,body}),
  });
  document.getElementById('cache-dialog').close();
  loadCache();
}
</script>
</body>
</html>
`;
  }
}
