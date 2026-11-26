/**
 * The public HTML: the upload page behind an upload link, and the small page
 * shown for a dead or unknown link. Self-contained (inline CSS and JS under a
 * per-response nonce), light and dark by `prefers-color-scheme`, no external
 * requests, and it never shows a server path: only the target folder's name.
 *
 * @module dsh-host-fileshare/upload-page
 */

import { randomBytes } from 'node:crypto'

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f5f5f7; --card: #ffffff; --text: #1d1d1f; --text-2: #6e6e73; --text-3: #86868b;
  --accent: #0071e3; --accent-hover: #0077ed; --fill: #f5f5f7; --line: rgba(0,0,0,0.08);
  --ok: #1d9b4b; --bad: #d70015; --drop: rgba(0,113,227,0.06);
  --shadow: 0 2px 8px rgba(0,0,0,0.04), 0 12px 40px rgba(0,0,0,0.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000; --card: #1c1c1e; --text: #f5f5f7; --text-2: #a1a1a6; --text-3: #8e8e93;
    --accent: #2997ff; --accent-hover: #47a6ff; --fill: #2c2c2e; --line: rgba(255,255,255,0.1);
    --ok: #30d158; --bad: #ff453a; --drop: rgba(41,151,255,0.10);
    --shadow: none;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; font-size: 17px; line-height: 1.47; letter-spacing: -0.022em;
  min-height: 100vh; display: flex; justify-content: center; padding: 64px 20px;
}
main { width: 100%; max-width: 640px; display: flex; flex-direction: column; gap: 28px; }
.eyebrow { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-3); letter-spacing: 0; }
h1 { margin: 6px 0 0; font-size: 40px; line-height: 1.1; font-weight: 600; letter-spacing: -0.015em; }
.lead { margin: 10px 0 0; color: var(--text-2); font-size: 19px; line-height: 1.42; }
.card { background: var(--card); border-radius: 22px; box-shadow: var(--shadow); padding: 28px; }
.drop {
  display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 44px 20px; text-align: center;
  border-radius: 18px; border: 1.5px dashed var(--line); background: transparent; cursor: pointer;
  transition: background .2s ease, border-color .2s ease; width: 100%; color: inherit; font: inherit;
}
.drop:hover, .drop.over { background: var(--drop); border-color: var(--accent); }
.drop:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 40%, transparent); outline-offset: 3px; }
.drop svg { color: var(--accent); }
.drop-title { font-size: 19px; font-weight: 600; }
.drop-sub { font-size: 14px; color: var(--text-2); }
.btn {
  display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 18px; border: 0; border-radius: 980px;
  background: var(--accent); color: #fff; font: inherit; font-size: 15px; cursor: pointer;
}
.btn:hover { background: var(--accent-hover); }
.meta { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: 20px; font-size: 14px; color: var(--text-2); }
.meta b { color: var(--text); font-weight: 600; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
li { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; padding: 14px 0; border-top: 1px solid var(--line); }
li:first-child { border-top: 0; }
.fname { font-size: 15px; font-weight: 500; overflow-wrap: anywhere; }
.fstate { font-size: 13px; color: var(--text-2); text-align: right; white-space: nowrap; }
.fstate.ok { color: var(--ok); } .fstate.bad { color: var(--bad); }
.bar { grid-column: 1 / -1; height: 4px; border-radius: 4px; background: var(--fill); overflow: hidden; }
.bar > i { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 4px; transition: width .15s linear; }
.empty { font-size: 14px; color: var(--text-3); }
.section-title { margin: 0 0 6px; font-size: 21px; font-weight: 600; }
.foot { font-size: 12px; color: var(--text-3); text-align: center; }
.hidden { display: none; }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; background: var(--fill); padding: 2px 6px; border-radius: 6px; }
@media (max-width: 520px) { body { padding: 40px 16px; } h1 { font-size: 32px; } .card { padding: 20px; } }
`

const SCRIPT = `
(() => {
  const status = JSON.parse(document.getElementById('status').textContent);
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => { if (n < 1024) return n + ' B'; const u = ['KB','MB','GB','TB']; let v = n / 1024, i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]; };
  const when = (iso) => { const d = new Date(iso); return d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  let filesLeft = status.filesLeft, bytesLeft = status.bytesLeft;
  const render = () => { $('left').textContent = filesLeft + ' 个文件 · ' + fmt(bytesLeft); };
  $('expires').textContent = when(status.expiresAt);
  render();
  const list = $('list');
  const done = $('done');
  for (const f of status.files) addRow(f.name, '已收到 · ' + fmt(f.size), 'ok', 100);
  function addRow(name, text, tone, pct) {
    done.classList.add('hidden');
    const li = document.createElement('li');
    const n = document.createElement('span'); n.className = 'fname'; n.textContent = name;
    const s = document.createElement('span'); s.className = 'fstate' + (tone ? ' ' + tone : ''); s.textContent = text;
    const bar = document.createElement('div'); bar.className = 'bar'; const fill = document.createElement('i'); fill.style.width = (pct || 0) + '%'; bar.append(fill);
    li.append(n, s, bar); list.prepend(li);
    return { s, fill, li };
  }
  const queue = []; let busy = false;
  function enqueue(files) { for (const f of files) queue.push(f); pump(); }
  function pump() {
    if (busy || queue.length === 0) return;
    const file = queue.shift(); busy = true;
    const row = addRow(file.name, '等待…', '', 0);
    if (filesLeft <= 0) { finish(row, '文件数已达上限', 'bad'); return; }
    if (file.size > bytesLeft) { finish(row, '太大了（还剩 ' + fmt(bytesLeft) + '）', 'bad'); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); row.fill.style.width = p + '%'; row.s.textContent = p + '% · ' + fmt(e.total); } };
    xhr.onload = () => {
      let body = {}; try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 201 && body.ok) {
        filesLeft = body.filesLeft; bytesLeft = body.bytesLeft; render();
        row.fill.style.width = '100%';
        finish(row, (body.name !== file.name ? '已收到，保存为 ' + body.name : '已收到') + ' · ' + fmt(body.size), 'ok');
      } else finish(row, body.error || ('失败（' + xhr.status + '）'), 'bad');
    };
    xhr.onerror = () => finish(row, '网络中断', 'bad');
    xhr.send(file);
  }
  function finish(row, text, tone) { row.s.textContent = text; row.s.className = 'fstate ' + tone; busy = false; pump(); }
  const drop = $('drop'), input = $('file');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { enqueue(input.files); input.value = ''; });
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => enqueue(e.dataTransfer.files));
  document.addEventListener('paste', (e) => { if (e.clipboardData && e.clipboardData.files.length) enqueue(e.clipboardData.files); });
})();
`

const ICON = '<svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true"><circle cx="22" cy="22" r="21" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/><path d="M22 29V14m0 0-6 6m6-6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function csp(nonce) {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
}

/**
 * @param {{ state: string, folder: string, expiresAt: string, filesLeft: number, bytesLeft: number, files: {name: string, size: number}[] }} status
 */
export function uploadPage(status) {
  if (status.state !== 'active') {
    const titles = { expired: ['链接已过期', '这个上传链接已经过了有效期。'], revoked: ['链接已撤销', '这个上传链接已经被撤销。'], 'used-up': ['已经收满了', '这个上传链接的文件数或容量已经用完。'] }
    const [title, text] = titles[status.state] ?? titles.expired
    return notePage(title, text)
  }
  const nonce = randomBytes(16).toString('base64')
  const data = JSON.stringify(status).replace(/</g, '\\u003c')
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>上传文件</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
  <header>
    <p class="eyebrow">文件中转</p>
    <h1>上传文件</h1>
    <p class="lead">文件会放进「${escapeHtml(status.folder)}」，对方马上就能拿到。</p>
  </header>
  <section class="card">
    <button class="drop" id="drop" type="button">
      ${ICON}
      <span class="drop-title">拖到这里，或点一下选文件</span>
      <span class="drop-sub">也可以直接粘贴。可以一次选多个。</span>
    </button>
    <input id="file" type="file" multiple class="hidden">
    <div class="meta">
      <span>还能传 <b id="left"></b></span>
      <span>有效至 <b id="expires"></b></span>
    </div>
  </section>
  <section class="card">
    <h2 class="section-title">已上传</h2>
    <p class="empty" id="done">还没有文件。</p>
    <ul id="list"></ul>
  </section>
  <p class="foot">命令行：<code>curl -T 文件 这个页面的地址</code></p>
</main>
<script type="application/json" id="status">${data}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`
  return { body, csp: csp(nonce) }
}

/** A one-message page (dead link, unknown link, error). */
export function notePage(title, text) {
  const nonce = randomBytes(16).toString('base64')
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${CSS}
body { align-items: center; } main { text-align: center; max-width: 520px; }
</style>
</head>
<body>
<main>
  <p class="eyebrow">文件中转</p>
  <h1>${escapeHtml(title)}</h1>
  <p class="lead">${escapeHtml(text)}</p>
</main>
</body>
</html>
`
  return { body, csp: csp(nonce) }
}
