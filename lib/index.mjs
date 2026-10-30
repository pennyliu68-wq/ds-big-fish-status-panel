// 状态台 —— DSH 宿主半边
//
// 做三件事：
//   1. 把 /dsh-paofu-console 挂到 DSH 的 webServer 上，返回 web/index.html；
//   2. 自己起一个只监听 127.0.0.1 的数据服务（默认 9896），提供 /api/*、/meme/*、/data/*，
//      并把内部接口 /__paofu__/* 反向代理过去 —— 页面始终用相对路径，不关心自己挂在哪；
//   3. 桥接（qq-bridge）在就接上，不在就只显示本地 data/ 里的内容，不报错、不崩。
//
// 不碰 DSH 的设置命名空间、会话、模型。两个入口都只允许本机回环访问。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'paofu-console';
export const inject = ['webServer'];

const PREFIX = '/dsh-paofu-console';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const WEB = path.join(PKG, 'web');

/* —— 配置：环境变量优先 ——
 * PAFU_BRIDGE   桥接根目录。没设就先找几个常见位置，找不到就当没有桥接
 *               （面板只显示本地 data/，不报错）
 * PAFU_CONSOLE  面板数据根目录（下挂 data/），默认包内目录
 * PAFU_PORT     数据服务端口，默认 9896
 * PAFU_TOKEN    桥接控制台 token，默认读 <BRIDGE>/state/console-token
 */
function guessBridge() {
  const fromEnv = String(process.env.PAFU_BRIDGE || '').trim();
  if (fromEnv) return fromEnv.replace(/[\\]+/g, '/');
  const home = os.homedir();
  const cands = [
    path.join(home, 'qq-bridge'),
    path.join(home, 'Documents', 'qq-bridge'),
    path.join(home, 'deepseek-harness', 'qq-bridge'),
    path.join(process.cwd(), 'qq-bridge'),
    path.join(process.cwd(), '..', 'qq-bridge'),
    'D:/qq-bridge',
  ];
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'src', 'bridge.js'))) return c.replace(/[\\]/g, '/'); } catch {}
  }
  // 找不到就是没有桥接，不猜盘符
  return null;
}
const BR = guessBridge();
// BR 可能是 null（没找到桥接）。bp() 在这种情况下给一条不存在的路径，
// 下面所有读写自然落空，不报错、不崩。
const bp = (...p) => (BR ? path.join(BR, ...p) : path.join(path.sep, '__no_bridge__', ...p));
// 桥接的 HTTP 口（只在本机回环上），可用 PAFU_BRIDGE_PORT 覆盖
const BRIDGE_URL = 'http://127.0.0.1' + ':' + String(process.env.PAFU_BRIDGE_PORT || 3100);
const ROOT = String(process.env.PAFU_CONSOLE || PKG).replace(/[\\]+/g, '/');
// 数据目录：桥接那边有真实数据就用它，没有才退回包内 data/。
// 桥接的是 state/agents/console/data/，里面是日记、记忆、承诺、小说、用量这些真实内容；
// 包内那份只是给没接桥接的人看的示例。
function pickDataDir() {
  const fromEnv = String(process.env.PAFU_DATA || '').trim();
  if (fromEnv) return fromEnv.replace(/[\\]+/g, '/');
  const cands = [
    bp('state', 'agents', 'console', 'data'),
    bp('state', 'console', 'data'),
    bp('data'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'mood.json'))) return c.replace(/[\\]+/g, '/'); } catch {}
  }
  return path.join(PKG, 'data').replace(/[\\]+/g, '/');
}
const DATA_DIR = pickDataDir();
// 读数据文件：先找真实数据目录，找不到再退回包内示例
const dataFile = (name) => {
  const real = path.join(DATA_DIR, name);
  try { if (fs.existsSync(real)) return real; } catch {}
  return path.join(PKG, 'data', name);
};
const PORT = Number(process.env.PAFU_PORT || 9896);
const HOST = '127.0.0.1';

// 自定义设置落盘位置：跟数据目录同一处，端口怎么变都不受影响
const CUSTOM_FILE = (() => {
  const cands = [
    bp('state', 'agents', 'console', 'data', 'custom.json'),
    path.join(PKG, 'data', 'custom.json'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(path.dirname(c))) return c; } catch {}
  }
  return cands[0];
})();

function readCustom() {
  try {
    const obj = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}

// 只允许这几个键，值和长度都收住：
// 防止被塞进任意大的数据，也防止把磁盘写满。
const CUSTOM_LIMITS = { name: 32, avatarBytes: 250 * 1024, bgBytes: 3 * 1024 * 1024, trackBytes: 45 * 1024 * 1024 };
const DATA_URL_RE = /^data:(image\/(png|jpe?g|webp|gif)|video\/(mp4|webm));base64,/i;

// 主题、背景、音乐这类大块内容单独存一个文件，
// 免得每次改个名字都要把几 MB 的视频重新读写一遍。同样的道理：它们属主目录，跟端口无关。
const ASSET_FILE = (() => {
  const cands = [
    bp('state', 'agents', 'console', 'data', 'custom-assets.json'),
    path.join(PKG, 'data', 'custom-assets.json'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(path.dirname(c))) return c; } catch {}
  }
  return cands[0];
})();

function readAssets() {
  try {
    const obj = JSON.parse(fs.readFileSync(ASSET_FILE, 'utf8'));
    if (obj && typeof obj === 'object' && obj.data && typeof obj.data === 'object') return obj.data;
    return {};
  } catch { return {}; }
}

function writeAssets(data) {
  fs.mkdirSync(path.dirname(ASSET_FILE), { recursive: true });
  const tmp = ASSET_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: new Date().toISOString(), data }), 'utf8');
  fs.renameSync(tmp, ASSET_FILE);
  return data;
}

// 主题与背景：接收 data URL，按大小上限收着。只替换传进来的键，其余保持不动。
function saveAssets(patch) {
  const cur = readAssets();
  const next = { ...cur };
  if (patch.theme && typeof patch.theme === 'object' && !Array.isArray(patch.theme)) next.theme = patch.theme;
  if (patch.bg !== undefined) {
    if (patch.bg === null || patch.bg === '') delete next.bg;
    else if (typeof patch.bg === 'object') {
      const src = String(patch.bg.src || '');
      if (src && !DATA_URL_RE.test(src)) throw new Error('背景必须是 data:image/... 或 data:video/...;base64, 形式');
      if (src.length > CUSTOM_LIMITS.bgBytes) throw new Error('背景文件太大（上限 3MB）');
      next.bg = {
        name: String(patch.bg.name || '').slice(0, 120),
        type: String(patch.bg.type || '').slice(0, 60),
        op: Number(patch.bg.op) || 0,
        blur: Number(patch.bg.blur) || 0,
        src,
      };
    }
  }
  // 曲目：这里只收元信息；音频本体走 /api/track/<id> 单独传，不经这个 JSON
  if (Array.isArray(patch.tracks)) {
    const oldTracks = Array.isArray(cur.tracks) ? cur.tracks : [];
    const list = [];
    for (const it of patch.tracks.slice(0, 60)) {
      if (!it || typeof it !== 'object') continue;
      const id = String(it.id || '').slice(0, 40);
      if (!id) continue;
      const keep = oldTracks.find(t => t && t.id === id);
      list.push({
        id,
        name: String(it.name || (keep && keep.name) || '').slice(0, 160),
        at: Number(it.at) || (keep && keep.at) || Date.now(),
        blob: (keep && keep.blob) || '',
        type: (keep && keep.type) || '',
      });
    }
    next.tracks = list;
  }
  // 上次在听哪首（纯字符串，不设大小限制也无所谓）
  if (typeof patch.lastTrack === 'string') next.lastTrack = patch.lastTrack.slice(0, 40);
  return writeAssets(next);
}

// 对外的曲目列表：不把 base64 本体发出去，只给元信息和有没有本体
function publicTracks() {
  const cur = readAssets();
  return (Array.isArray(cur.tracks) ? cur.tracks : []).map(t => ({ id: t.id, name: t.name, at: t.at, has: !!t.blob }));
}

function putTrack(id, name, type, buffer) {
  if (buffer.length > CUSTOM_LIMITS.trackBytes) throw new Error('音频太大（上限 45MB）');
  const cur = readAssets();
  const list = (Array.isArray(cur.tracks) ? cur.tracks : []).filter(t => t && t.id !== id);
  list.push({ id, name, type, at: Date.now(), blob: buffer.toString('base64') });
  writeAssets({ ...cur, tracks: list });
  return publicTracks();
}

function getTrackBlob(id) {
  const cur = readAssets();
  const t = (Array.isArray(cur.tracks) ? cur.tracks : []).find(x => x && x.id === id);
  return t && t.blob ? Buffer.from(t.blob, 'base64') : null;
}

function delTrack(id) {
  const cur = readAssets();
  writeAssets({ ...cur, tracks: (Array.isArray(cur.tracks) ? cur.tracks : []).filter(t => !(t && t.id === id)) });
  return publicTracks();
}

function saveCustom(patch) {
  const cur = readCustom();
  const next = { ...cur };
  if (typeof patch.name === 'string') {
    next.name = patch.name.replace(/\s+/g, ' ').trim().slice(0, CUSTOM_LIMITS.name);
  }
  if (typeof patch.avatar === 'string') {
    // 只收 data: 图片，且大小受限；空串表示恢复默认
    if (!patch.avatar) delete next.avatar;
    else if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(patch.avatar) && patch.avatar.length <= CUSTOM_LIMITS.avatarBytes) next.avatar = patch.avatar;
  }
  if (patch.navNames && typeof patch.navNames === 'object' && !Array.isArray(patch.navNames)) {
    const m = {};
    for (const k of Object.keys(patch.navNames).slice(0, 40)) {
      const v = patch.navNames[k];
      if (typeof v === 'string' && v.trim()) m[String(k).slice(0, 24)] = v.replace(/\s+/g, ' ').trim().slice(0, 24);
    }
    next.navNames = m;
  }
  if (Array.isArray(patch.hidden)) {
    next.hidden = patch.hidden.filter(x => typeof x === 'string').slice(0, 40).map(x => x.slice(0, 24));
  }
  next.at = new Date().toISOString();
  fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true });
  const tmp = CUSTOM_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, CUSTOM_FILE);
  return next;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function readToken() {
  const fromEnv = String(process.env.PAFU_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  // 多试几个位置：BR 探测可能因为 DSH 的工作目录不同而算错
  const cands = [
    bp('state', 'console-token'),
    'D:/qq-bridge/state/console-token',
    path.join(os.homedir(), 'qq-bridge', 'state', 'console-token'),
  ];
  for (const c of cands) {
    try {
      const t = fs.readFileSync(c, 'utf8').trim();
      if (t) return t;
    } catch {}
  }
  return '';
}

function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
}
function listDir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function textFile(p, max) {
  try { return fs.readFileSync(p, 'utf8').slice(0, max || 4000); } catch { return ''; }
}
const asArr = x => Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.values(x) : []);

function localOnly(req) {
  const addr = String((req.socket && req.socket.remoteAddress) || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ── 桥接侧数据 ────────────────────────────────────────────────────────────
async function bridgeStatus(token) {
  try {
    const r = await fetch(BRIDGE_URL + '/api/status', { headers: { 'x-console-token': token } });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
async function bridgeJson(pathname, token) {
  try {
    const r = await fetch(BRIDGE_URL + pathname, { headers: { 'x-console-token': token } });
    return await r.json();
  } catch { return null; }
}

function convs() {
  const j = readJson(bp('state', 'social-v2.json'), { conversations: {} });
  const out = [];
  for (const [key, c] of Object.entries(j.conversations || {})) {
    out.push({
      key,
      unread: Array.isArray(c.unread) ? c.unread.length : (Number(c.unread) || 0),
      lastIncomingAt: c.lastIncomingAt || c.lastActionAt || null,
      lastReplyAt: c.lastAiReplyAt || null,
      wake: c.wakeConfig ? c.wakeConfig.mode : null,
      topics: asArr(c.activeTopics).map(t => t && (t.content || t.text)).filter(Boolean).slice(-3),
      impressions: asArr(c.memberImpressions).map(m => ({ who: m && (m.target || m.who), note: m && (m.content || m.note) })).slice(-3),
    });
  }
  out.sort((a, b) => (b.lastIncomingAt || 0) - (a.lastIncomingAt || 0));
  return out;
}

function diary() {
  const dir = bp('state', 'diary');
  return listDir(dir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 8).map(f => {
    const txt = textFile(path.join(dir, f), 1e6);
    return { date: f.replace('.md', ''), chars: txt.length, excerpt: txt.replace(/\s+/g, ' ').slice(0, 160) };
  });
}

function voicesMeta() {
  const dir = bp('audio');
  const out = [];
  for (const nm of listDir(dir)) {
    if (!/\.(wav|mp3|m4a)$/i.test(nm)) continue;
    const full = path.join(dir, nm);
    let st; try { st = fs.statSync(full); } catch { continue; }
    let sec = null;
    if (/\.wav$/i.test(nm)) {
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(64);
        fs.readSync(fd, buf, 0, 64, 0);
        fs.closeSync(fd);
        let p = 12, byteRate = 0, dataLen = 0;
        while (p + 8 <= buf.length) {
          const id = buf.toString('ascii', p, p + 4);
          const size = buf.readUInt32LE(p + 4);
          if (id === 'fmt ') byteRate = buf.readUInt32LE(p + 16);
          else if (id === 'data') { dataLen = size; break; }
          p += 8 + size + (size % 2);
          if (p > 40) break;
        }
        if (byteRate > 0 && dataLen > 0) sec = dataLen / byteRate;
        else if (byteRate > 0) sec = Math.max(0, (st.size - 44)) / byteRate;
      } catch { sec = null; }
    }
    out.push({ name: nm, bytes: st.size, mtime: st.mtimeMs, sec: sec == null ? null : Math.round(sec * 10) / 10 });
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out;
}

function memesList() {
  const base = bp('memes');
  const out = [];
  function walk(dir, rel, depth) {
    if (depth > 2) return;
    for (const nm of listDir(dir)) {
      const full = path.join(dir, nm);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (nm === '_trash') continue; walk(full, rel ? rel + '/' + nm : nm, depth + 1); }
      else if (/\.(png|jpg|jpeg|gif|webp)$/i.test(nm)) out.push(rel ? rel + '/' + nm : nm);
      if (out.length >= 60) return;
    }
  }
  walk(base, '', 0);
  return out.slice(0, 60);
}

function assets() {
  const voices = listDir(bp('audio')).filter(f => /\.(wav|mp3|m4a)$/i.test(f));
  const memes = memesList();
  const meta = voicesMeta();
  return { voices: voices.length, memes: memes.length, voiceSamples: voices.slice(0, 6), voiceMeta: meta.slice(0, 60) };
}

function disks() {
  const out = [];
  const sep = path.sep;
  const mounts = process.platform === 'win32'
    ? [['C:', 'C:' + sep], ['D:', 'D:' + sep], ['E:', 'E:' + sep]]
    : [['/', '/']];
  for (const [nm, p] of mounts) {
    try {
      const st = fs.statfsSync(p);
      const total = st.blocks * st.bsize;
      const free = st.bfree * st.bsize;
      if (!total) continue;
      out.push({ name: nm, totalMB: Math.round(total / 1048576), freeMB: Math.round(free / 1048576), usedPct: Math.round((1 - free / total) * 100) });
    } catch {}
  }
  return out;
}

function hostInfo() {
  const total = os.totalmem(), free = os.freemem();
  let procs = [];
  if (process.platform === 'win32') {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: 'utf8', timeout: 4000 });
      procs = out.split('\n').filter(l => l.indexOf('node.exe') >= 0).map(l => {
        const c = l.split('","').map(x => x.replace(/^"|"$/g, ''));
        return { pid: c[1], mem: c[4] };
      }).filter(p => p.pid && p.mem);
    } catch {}
  }
  return {
    memTotalMB: Math.round(total / 1048576), memFreeMB: Math.round(free / 1048576), procs: procs.slice(0, 8),
    nodeCount: procs.length, disks: disks(), uptime: Math.round(process.uptime()), panelAt: Date.now(),
  };
}

// 人格卡：桥接给了就用桥接的，否则读本地 data/roles*.md
async function rolesInfo(token) {
  const fromBridge = await bridgeJson('/api/roles', token);
  if (fromBridge && Array.isArray(fromBridge.summaries) && fromBridge.summaries.length) return fromBridge;

  const out = [];
  for (const dir of [bp('agent-presets'), bp('dsh', 'agent-presets'), ROOT]) {
    for (const nm of listDir(dir)) {
      if (!/\.(md|txt)$/i.test(nm) || nm === 'novel.md') continue;
      const full = path.join(dir, nm);
      let txt = '', st = null;
      try { txt = fs.readFileSync(full, 'utf8'); st = fs.statSync(full); } catch { continue; }
      out.push({
        name: nm.replace(/\.(md|txt)$/i, ''),
        chars: txt.replace(/\s+/g, '').length,
        lines: txt.split('\n').length,
        mtime: st.mtimeMs,
        excerpt: txt.replace(/\s+/g, ' ').slice(0, 300),
      });
    }
    if (out.length) break;
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { roles: out.map(r => r.name), summaries: out };
}

async function snapshot(token) {
  const st = await bridgeStatus(token);
  return {
    ok: true,
    at: new Date().toISOString(),
    now: {
      mode: st.mode, role: st.role, paused: st.socialV2Paused,
      dshReady: st.dshReady, ownerQQ: st.ownerQQ,
      snowluma: st.snowluma ? { online: st.snowluma.accountOnline, good: st.snowluma.good } : null,
      groups: st.allowGroups || [], privates: st.allowPrivate || [],
    },
    activity: String(st.activity || '').split('\n').filter(Boolean).slice(-8).reverse(),
    conversations: convs(),
    diary: diary(),
    assets: assets(),
    mood: readJson(dataFile('mood.json'), null) || readJson(bp('state', 'mood.json'), null),
    roles: await rolesInfo(token),
    memesList: memesList(),
    promises: readJson(dataFile('promises.json'), []),
    novel: textFile(dataFile('novel.md'), 6000),
    history: readJson(dataFile('history.json'), []),
    skills: readJson(dataFile('skills.json'), []),
    host: hostInfo(),
  };
}

// ── 数据服务：页面要的 /api、/data、/meme 都在这儿 ────────────────────────
function createDataServer() {
  const SCRIPTS = bp('scripts');

  function runScript(file) {
    return new Promise(resolve => {
      execFile(process.execPath, [path.join(SCRIPTS, file)], { timeout: 180000, windowsHide: true }, (err) => {
        resolve({ file, ok: !err, err: err ? String(err.message || err).slice(0, 200) : null });
      });
    });
  }
  async function refreshAll() {
    const results = [];
    // 顺序有讲究：先拉官方余额，再算用量，最后 export-usage 把余额/花费合并回面板
    for (const f of ['export-balance.mjs', 'refresh-usage.mjs', 'export-usage.mjs', 'export-memory.mjs']) {
      results.push(await runScript(f));
    }
    return { ok: results.every(r => r.ok), at: new Date().toISOString(), results };
  }

  return http.createServer(async (req, res) => {
    const token = readToken();
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-console-token',
      'access-control-max-age': '600',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    let url;
    try { url = new URL(req.url || '/', 'http://x'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }

    // 写接口必须带控制台令牌。
    //
    // 曾经这里还放行「来源是本机」的请求，因为浏览器的 Referer 不一定发得出去。
    // 但那等于让本机任何一个网页都能改你的配置：服务只绑回环，别的机器够不着，
    // 可同一台机器上的网页够得着。现在页面加载时由 sendFile 把令牌注入进去，
    // 前端所有 fetch 都会带上，所以这条路不再需要放宽。
    const writable = () => {
      const tok = String(req.headers['x-console-token'] || '');
      // 没配令牌时退化成只认本机回环（外层 handler 已经挡住了非回环请求）
      if (!token) return true;
      return tok === token;
    };
    // 收二进制体：返回 Promise，超限直接 413
    const readBody = (limit) => new Promise((resolve) => {
      const chunks = [];
      let size = 0, tooBig = false;
      req.on('data', c => {
        size += c.length;
        if (size > limit) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    });

    if (url.pathname === '/api/refresh') {
      if (!writable()) { res.writeHead(403, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"forbidden"}'); }
      const started = Date.now();
      const out = await refreshAll();
      res.writeHead(out.ok ? 200 : 500, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ...out, elapsedMs: Date.now() - started }));
    }

    if (url.pathname === '/api/meme/upload' || url.pathname === '/api/meme/delete') {
      if (!writable()) { res.writeHead(403, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"forbidden"}'); }
      const memebase = path.resolve(bp('memes'));
      const rawName = String(url.searchParams.get('name') || '').trim();
      const safeName = path.basename(rawName).replace(/[\/:*?"<>|]/g, '_');
      if (!safeName) { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"bad name"}'); }
      const target = path.resolve(path.join(memebase, safeName));
      if (!target.toLowerCase().startsWith(memebase.toLowerCase() + path.sep)) {
        res.writeHead(403, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"outside"}');
      }

      if (url.pathname === '/api/meme/delete') {
        const trash = path.join(memebase, '_trash');
        fs.mkdirSync(trash, { recursive: true });
        if (!fs.existsSync(target)) { res.writeHead(404, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"not found"}'); }
        const dest = path.join(trash, Date.now() + '_' + safeName);
        try {
          fs.renameSync(target, dest);
          return sendJson(res, 200, { ok: true, moved: path.relative(memebase, dest) });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: String(e.message || e) });
        }
      }

      const chunks = [];
      let size = 0, tooBig = false;
      req.on('data', c => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) { res.writeHead(413, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"too large (>8MB)"}'); }
        try {
          fs.mkdirSync(memebase, { recursive: true });
          let finalName = safeName;
          const ext = path.extname(safeName) || '.png';
          const stem = path.basename(safeName, ext);
          let n = 1;
          while (fs.existsSync(path.join(memebase, finalName))) { finalName = stem + '-' + n + ext; n += 1; }
          fs.writeFileSync(path.join(memebase, finalName), Buffer.concat(chunks));
          sendJson(res, 200, { ok: true, name: finalName, bytes: size });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e.message || e) });
        }
      });
      return;
    }

    // 自定义设置：名字、头像、页签改名、隐藏页签。
    // 以前这些只放在浏览器的 localStorage 里，而 localStorage 按「来源」隔离 ——
    // DSH 每次重启端口都会变（同一个 127.0.0.1 上换一个端口就是另一个站点），
    // 于是换个端口就等于换了个空仓库，自定义全丢。存到服务端就跟端口无关了。
    if (url.pathname === '/api/me' || url.pathname.startsWith('/api/me?') || url.pathname === '/api/me/save') {
      if (req.method === 'GET') {
        const body = JSON.stringify({ ok: true, data: readCustom() });
        res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(body);
      }
      if (!writable()) { res.writeHead(403, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"forbidden"}'); }
      const chunks = [];
      let size = 0, tooBig = false;
      req.on('data', c => {
        size += c.length;
        if (size > 2 * 1024 * 1024) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) { res.writeHead(413, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"too large (>2MB)"}'); }
        let patch;
        try { patch = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { patch = null; }
        if (!patch || typeof patch !== 'object') { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"bad json"}'); }
        try { saveCustom(patch); } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
        return sendJson(res, 200, { ok: true, data: readCustom() });
      });
      return;
    }

    // 主题 / 背景 / 音乐列表：跟名字头像一样，必须存服务端，否则换端口就全丢
    if (url.pathname === '/api/assets' || url.pathname.startsWith('/api/assets?')) {
      if (req.method === 'GET') {
        const cur = readAssets();
        const out = { theme: cur.theme || null, bg: cur.bg || null, tracks: publicTracks(), lastTrack: cur.lastTrack || '' };
        res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ ok: true, data: out }));
      }
      if (!writable()) { res.writeHead(403, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"forbidden"}'); }
      const chunks = [];
      let size = 0, tooBig = false;
      req.on('data', c => {
        size += c.length;
        if (size > 5 * 1024 * 1024) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) { res.writeHead(413, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"too large (>5MB)"}'); }
        let patch;
        try { patch = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { patch = null; }
        if (!patch || typeof patch !== 'object') { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"bad json"}'); }
        try { saveAssets(patch); } catch (e) { return sendJson(res, 400, { ok: false, error: String(e.message || e) }); }
        const cur = readAssets();
        return sendJson(res, 200, { ok: true, data: { theme: cur.theme || null, bg: cur.bg || null, tracks: publicTracks() } });
      });
      return;
    }

    // 单条曲目：PUT /api/track/<id>?name=xxx 传原始字节；GET 取音频本体；DELETE 删掉
    if (url.pathname.startsWith('/api/track/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/track/'.length)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      if (!id) { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"bad id"}'); }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const buf = getTrackBlob(id);
        if (!buf) { res.writeHead(404, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"not found"}'); }
        res.writeHead(200, { ...cors, 'content-type': 'audio/mpeg', 'content-length': buf.length, 'cache-control': 'no-store', 'accept-ranges': 'none' });
        if (req.method === 'HEAD') return res.end();
        return res.end(buf);
      }
      if (!writable()) { res.writeHead(403, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"forbidden"}'); }
      if (req.method === 'DELETE') {
        try { const list = delTrack(id); return sendJson(res, 200, { ok: true, tracks: list }); }
        catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
      }
      const chunks = [];
      let size = 0, tooBig = false;
      req.on('data', c => {
        size += c.length;
        if (size > CUSTOM_LIMITS.trackBytes) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) { res.writeHead(413, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"audio too large (>45MB)"}'); }
        const name = String(url.searchParams.get('name') || '').slice(0, 160) || (id + '.mp3');
        const type = String(req.headers['content-type'] || 'audio/mpeg').slice(0, 60);
        try { const list = putTrack(id, name, type, Buffer.concat(chunks)); return sendJson(res, 200, { ok: true, id, bytes: size, tracks: list }); }
        catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
      });
      return;
    }

    if (url.pathname === '/api/snapshot') {
      const body = JSON.stringify(await snapshot(token));
      res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(body);
    }

    if (url.pathname.startsWith('/meme/')) {
      const relName = decodeURIComponent(url.pathname.slice(6)).replace(/[.][.]/g, '');
      const base = path.resolve(bp('memes'));
      const mp = path.resolve(path.join(base, relName));
      if (!mp.toLowerCase().startsWith(base.toLowerCase())) { res.writeHead(403, cors); return res.end('no'); }
      return fs.readFile(mp, (err, buf) => {
        if (err) { res.writeHead(404, cors); return res.end('no'); }
        const ext = path.extname(mp).toLowerCase();
        const type = ext === '.gif' ? 'image/gif' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, { ...cors, 'content-type': type, 'cache-control': 'max-age=600' });
        res.end(buf);
      });
    }

    // /data/* 与其余静态文件：先找真实数据目录（桥接的 console/data），再退回包内
    const rel0 = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    // 页面请求的是 /data/xxx.json，但数据目录本身就是 .../data/，
    // 所以要把开头的 data/ 去掉，否则会拼成 data/data/xxx.json
    const rel = rel0.replace(/^data\//, '');
    const roots = [DATA_DIR, path.join(PKG, 'data'), ROOT];
    const safeRel = path.posix.normalize(rel).replace(/^(\.\.\/)+/, '');
    const tries = roots.map(r => path.join(r, safeRel));
    let p = null;
    for (const t of tries) {
      const resolved = path.resolve(t);
      const ok = roots.some(base => {
        const b = path.resolve(base).toLowerCase() + path.sep;
        return resolved.toLowerCase().startsWith(b);
      });
      if (!ok) continue;
      try { if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) { p = resolved; break; } } catch {}
    }
    if (!p) { res.writeHead(404, cors); return res.end('not found'); }
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404, cors); return res.end('not found'); }
      const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { ...cors, 'content-type': type, 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
}

// ── DSH 侧：静态页 + 内部接口反代 ─────────────────────────────────────────
function proxyToData(req, res, pathname, search) {
  const up = http.request(
    { host: HOST, port: PORT, method: req.method, path: pathname + search, headers: { ...req.headers, host: HOST + ':' + PORT }, timeout: 15000 },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); },
  );
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', (err) => {
    if (res.headersSent) { res.end(); return; }
    sendJson(res, 503, {
      ok: false,
      error: '状态台的数据服务没有响应（' + HOST + ':' + PORT + '），刷新页面或重启 DSH 试试。',
      detail: String((err && err.message) || err),
    });
  });
  req.pipe(up);
}

function sendFile(res, file, req) {
  let st;
  try { st = fs.statSync(file); } catch { return sendJson(res, 404, { ok: false, error: 'not found' }); }
  if (!st.isFile()) return sendJson(res, 404, { ok: false, error: 'not a file' });
  const ext = path.extname(file).toLowerCase();

  // index.html 要动态注入一枚只读用的令牌：
  // 浏览器的 Referer 不一定发得出去，页面自己带 token 最稳。
  // 这枚 token 只在本机回环上有效，而且页面本身也只允许本机访问。
  if (ext === '.html' && path.basename(file) === 'index.html') {
    let html = '';
    try { html = fs.readFileSync(file, 'utf8'); } catch { return sendJson(res, 404, { ok: false, error: 'not found' }); }
    const tok = readToken();
    const inject = '<script>window.__PAFU_TOKEN=' + JSON.stringify(tok) + ';'
      + 'window.__paofuHeaders=function(){var h={};if(window.__PAFU_TOKEN)h["x-console-token"]=window.__PAFU_TOKEN;return h};'
      + '(function(){var _f=window.fetch;window.fetch=function(u,o){o=o||{};if(typeof u==="string"&&u.indexOf("__paofu__")>=0){o.headers=Object.assign({},window.__paofuHeaders(),o.headers||{})}return _f.call(window,u,o)}})();'
      + '</script>';
    html = html.replace('</head>', inject + '</head>');
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(buf);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

export function createHandler() {
  return async function handler(req, res) {
    if (!localOnly(req)) {
      sendJson(res, 403, { ok: false, error: '这个界面只允许本机访问。' });
      return;
    }
    let url;
    try { url = new URL(req.url || '/', 'http://' + (req.headers.host || '127.0.0.1')); }
    catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }

    let pathname = url.pathname;
    if (pathname === PREFIX) {
      res.writeHead(308, { location: PREFIX + '/' + url.search });
      res.end();
      return;
    }
    if (!pathname.startsWith(PREFIX + '/')) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    pathname = pathname.slice(PREFIX.length) || '/';

    // 数据走内部前缀，映射回数据服务自己的路径
    if (pathname.startsWith('/__paofu__/')) {
      proxyToData(req, res, pathname.slice('/__paofu__'.length), url.search);
      return;
    }

    // 页面里的相对路径（/api /data /meme /bg.js）也直接转到数据服务，
    // 这样插件页不依赖前端 shim 也能取到数据。
    if (pathname.startsWith('/meme/')) { proxyToData(req, res, pathname, url.search); return; }
    if (pathname === '/bg.js' || pathname.startsWith('/api/') || pathname.startsWith('/data/') || pathname.startsWith('/meme/')) {
      proxyToData(req, res, pathname, url.search);
      return;
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }

    let rel = pathname;
    if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(WEB, path.posix.normalize(rel)));
    if (!file.startsWith(WEB + path.sep) && file !== path.join(WEB, 'index.html')) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    sendFile(res, file, req);
  };
}

export function apply(ctx) {
  // 数据服务：端口被占说明已经起过一份，直接用现成的
  const dataServer = createDataServer();
  dataServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.log('[paofu-console] ' + PORT + ' 已被占用，直接用现成的数据服务');
      return;
    }
    console.error('[paofu-console] 数据服务出错：', err);
  });
  dataServer.listen(PORT, HOST, () => {
    console.log('[paofu-console] 数据服务 http://' + HOST + ':' + PORT + (readToken() ? '' : '（没有 console-token，桥接字段会留空）'));
  });

  const handler = createHandler();
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }));
  ctx.effect(() => () => { try { dataServer.close(); } catch {} });
}
