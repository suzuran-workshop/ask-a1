#!/usr/bin/env node
/**
 * index.js — 钉钉 A1 录音卡「AI 听记」桥接（单文件 · 零依赖）
 *
 * 把钉钉 A1 在云端生成的 AI 听记（转写全文 + AI 摘要 + 关键词）拉到本地，
 * 供 AI 定时拉取。CLI 与 HTTP 服务合一，仅用 Node 内置 fetch / WebSocket。
 *
 * 用法:
 *   node scripts/index.js <命令> [选项]
 *
 * 命令:
 *   fetch-token                     一键登录：开浏览器→扫码→存 token→自动关浏览器（约 30 天一次）
 *   doctor                          环境诊断（模式 / Chrome / 登录 / 存储）
 *   sync [--json]                   增量同步新听记
 *   list [--after N] [--limit N] [--json] [--full]   列出待处理想法
 *   get <id> [--json]               查看单条详情（含转写全文）
 *   consume <id>                    标记已消费
 *   status [--json]                 状态概览
 *   refresh [--json]                用列表接口回填已有条目的摘要 / 关键词
 *   serve [--port N]                启动 HTTP API 常驻服务
 *   up [--port N]                   确保浏览器调试实例在跑（无则拉起）再启动服务
 *
 * 运行模式（config.json 的 mode 字段）:
 *   auto（默认） 有未过期 oauthToken → WS 直连；否则回退 CDP
 *   ws           强制 WS 直连（需要先 fetch-token）
 *   cdp          强制浏览器模式（Chrome 调试实例）
 *
 * 退出码: 0 成功；1 参数 / 环境 / 未命中错误。失败信息写 stderr。
 *
 * 认证与生命周期（关键）:
 *   - 无浏览器模式用 oauth_k1 token（来自浏览器 cookie `account`，约 30 天有效）。
 *   - 每约 30 天执行一次 fetch-token 续期，其余时间浏览器可关闭。
 *   - 数据（config.json / data/）为本机私有，勿提交或外传。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execSync } = require('node:child_process');

// ---------- 路径与守卫 ----------
const HOME = path.join(__dirname, '..');           // 技能根（脚本父目录）
const CONFIG_PATH = path.join(HOME, 'config.json');
const DATA_DIR = path.join(HOME, 'data');
const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(function guardNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`❌ 需要 Node.js v22+（当前 v${process.versions.node}，脚本依赖内置 fetch/WebSocket）`);
    console.error('   请安装 Node.js 22 或更高版本: https://nodejs.org/');
    process.exit(1);
  }
})();

// ---------- 配置 ----------
// 常见浏览器路径（按优先级）
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Users\\%USERNAME%\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Users\\%USERNAME%\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser() {
  const username = process.env.USERNAME || '';
  for (const c of BROWSER_CANDIDATES) {
    const p = c.replace('%USERNAME%', username);
    if (fs.existsSync(p)) return p;
  }
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    for (const exe of ['chrome.exe', 'msedge.exe']) {
      const p = path.join(dir, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

// 探测空闲端口（避开 9222 被 Edge 占用等冲突）
function findFreePort(start) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    tryPort(start);
  });
}

// 首次运行自动生成 config.json（保留已有字段，只补默认值）
async function ensureConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { existing = {}; }
  }
  const cfg = {
    ...existing,
    port: existing.port || 8787,
    apiToken: existing.apiToken || crypto.randomBytes(24).toString('hex'),
    cdpPort: existing.cdpPort || await findFreePort(9333),
    chromePath: existing.chromePath || findBrowser(),
    pollIntervalSec: existing.pollIntervalSec || 300,
    pageSize: existing.pageSize || 20,
    maxPages: existing.maxPages || 20,
    mode: existing.mode || 'auto',
  };
  if (JSON.stringify(cfg) !== JSON.stringify(existing)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }
}

let CONFIG = null; // main() 里 ensureConfig() 之后才赋值
function loadConfig() {
  const def = {
    port: 8787, apiToken: crypto.randomBytes(24).toString('hex'), cdpPort: 9333,
    chromePath: '', pollIntervalSec: 300, pageSize: 20, maxPages: 20, mode: 'auto',
  };
  if (fs.existsSync(CONFIG_PATH)) {
    try { return { ...def, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
    catch (e) { console.error('[config] 解析失败，使用默认配置:', e.message); }
  }
  return def;
}

// ---------- 存储 ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
let ideas = readJson(IDEAS_FILE, { version: 1, items: [], nextId: 1 });
let state = readJson(STATE_FILE, { lastSync: 0, lastError: null, lastErrorAt: 0, lastSyncCount: 0, consecutiveFailures: 0 });
function saveIdeas() { writeJson(IDEAS_FILE, ideas); }
function saveState() { writeJson(STATE_FILE, state); }
function ideaByUuid(uuid) { return ideas.items.find(i => i.uuid === uuid); }

// ---------- 通用工具 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtTime(ms) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
function fmtDur(us) {
  if (!us) return '';
  const s = Math.round(us / 1000000);
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
  return `${Math.floor(s / 3600)}时${Math.floor((s % 3600) / 60)}分`;
}

// ---------- CDP 驱动（浏览器模式） ----------
// WebSocket 连接复用：同一页面复用一条连接，按消息 id 分发
const wsCache = new Map(); // url -> { ws, pending: Map<id, fn>, nextId }

async function cdpFindPage() {
  const tabs = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json`)).json();
  const page = tabs.find(t => t.type === 'page' && t.url.includes('shanji.dingtalk.com'));
  if (!page) throw new Error(`未找到 shanji 页面: 请先运行 node scripts/index.js up（或 fetch-token）启动浏览器调试实例并登录 AI 听记`);
  return page;
}

function cdpCall(page, expression, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const url = page.webSocketDebuggerUrl;
    let entry = wsCache.get(url);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
      if (entry) { try { entry.ws.close(); } catch {} wsCache.delete(url); }
      const ws = new WebSocket(url);
      entry = { ws, pending: new Map(), nextId: 0 };
      wsCache.set(url, entry);
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        const fn = entry.pending.get(m.id);
        if (fn) { entry.pending.delete(m.id); fn(m); }
      };
      ws.onclose = () => {
        if (wsCache.get(url) === entry) wsCache.delete(url);
        for (const fn of entry.pending.values()) fn({ error: 'closed' });
        entry.pending.clear();
      };
      ws.onerror = () => {
        for (const [id, fn] of entry.pending) { entry.pending.delete(id); fn({ error: 'ws-error' }); }
      };
    }
    const id = ++entry.nextId;
    const timer = setTimeout(() => {
      const fn = entry.pending.get(id);
      if (fn) { entry.pending.delete(id); fn({ error: 'timeout' }); }
    }, timeoutMs);
    entry.pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error === 'timeout') {
        // 超时说明页面卡死，销毁连接
        try { entry.ws.close(); } catch {}
        wsCache.delete(url);
        reject(new Error('CDP 执行超时'));
      } else if (m.error) {
        reject(new Error('CDP WebSocket 错误: ' + m.error));
      } else {
        resolve(m.result);
      }
    });
    const send = () => entry.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    if (entry.ws.readyState === WebSocket.OPEN) send();
    else entry.ws.addEventListener('open', send, { once: true });
  });
}

async function pageEval(expression) {
  const page = await cdpFindPage();
  const r = await cdpCall(page, expression);
  if (r && r.exceptionDetails) {
    const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
    throw new Error('页面执行异常: ' + (desc || JSON.stringify(r.exceptionDetails)).slice(0, 800));
  }
  return r && r.result && r.result.value;
}

// 抓取浏览器全部 cookie（fetch-token 用）
async function cdpGetCookies() {
  const page = await cdpFindPage();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP 抓 cookie 超时')); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies', params: {} }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) { clearTimeout(timer); resolve((m.result && m.result.cookies) || []); try { ws.close(); } catch {} }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('CDP 错误: ' + e.message)); };
  });
}

// 按调试端口查找 Chrome 主进程 PID（fetch-token 关闭浏览器用；Windows 专用）
function findChromePid(cdpPort) {
  try {
    const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${cdpPort}' } | Select-Object -First 1 -ExpandProperty ProcessId"`, { encoding: 'utf8' });
    const pid = parseInt(out.trim(), 10);
    return pid || 0;
  } catch { return 0; }
}

// 确保浏览器调试实例在跑（无则拉起）。端口一律用 CONFIG.cdpPort，避免与探测值错位。
async function ensureChrome() {
  const port = CONFIG.cdpPort;
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (Array.isArray(tabs)) return true;
  } catch {}
  const chrome = CONFIG.chromePath || DEFAULT_CHROME;
  if (!chrome || !fs.existsSync(chrome)) return false;
  const profile = path.join(process.env.TEMP || '.', 'a1-chrome-profile');
  spawn(chrome, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*',
    'https://shanji.dingtalk.com',
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (Array.isArray(t)) return true; } catch {}
  }
  return false;
}

// 刷新 shanji 页面（页面休眠 / JS 崩溃导致 webpack chunk 失效时，刷新即可恢复）
async function cdpReloadPage() {
  const page = await cdpFindPage();
  return new Promise((resolve) => {
    const url = page.webSocketDebuggerUrl;
    let entry = wsCache.get(url);
    if (entry && entry.ws.readyState === WebSocket.OPEN) {
      const id = ++entry.nextId;
      const timer = setTimeout(() => { try { entry.ws.close(); } catch {} resolve(false); }, 15000);
      entry.pending.set(id, () => { clearTimeout(timer); resolve(true); });
      entry.ws.send(JSON.stringify({ id, method: 'Page.reload', params: { ignoreCache: false } }));
    } else {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 15000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: false } }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { clearTimeout(timer); try { ws.close(); } catch {} resolve(true); }
      };
      ws.onerror = () => { clearTimeout(timer); resolve(false); };
    }
  });
}

// ---------- WS 直连（无浏览器模式） ----------
// 协议: wss://webalfa-cm3.dingtalk.com/long
//   1. HTTP Upgrade 握手(带 Origin/UA/Cookie, cookie 来自 fetch-token 抓取的页面 cookie)
//   2. /reg 注册帧(带 oauth_k1 token + app-key) → 服务端绑定会话, 返回 sid
//   3. /! 心跳帧(保活, 页面每 1~2 秒发一次; serve 每 30s)
//   4. 业务帧: {lwp:"/r/Adaptor/...", headers:{referer, mid, ...}, body:[...]} → {headers:{mid 回显, sid}, code, body}
// 凭证: oauth_k1 token 来自浏览器 cookie(account, domain=.dingtalk.com), 有效期约 30 天。
const WS_URL = 'wss://webalfa-cm3.dingtalk.com/long';
const WS_APP_KEY_DEFAULT = '5b46698304b45807569d343fcc5a2b61';
const WS_REFERER = 'https://shanji.dingtalk.com/app/transcribes-list';
const WS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 DingWeb/3.4.0 LANG/zh_CN';
let wsConn = null; // { sock, pending: Map<mid,fn>, sid, regDone }
let wsMidSeq = 0;

function wsMid() {
  return `${String(Math.random()).slice(2, 8)}${Date.now()}${String(Math.random()).slice(2, 8)} ${++wsMidSeq}`;
}

function wsModeEnabled() {
  const token = CONFIG.oauthToken;
  if (!token) return false;
  if (CONFIG.mode === 'ws') return true;
  if (CONFIG.mode === 'cdp') return false;
  // auto: token 有效期内走 WS 直连, 过期回退 CDP
  return !CONFIG.oauthTokenExpireAt || CONFIG.oauthTokenExpireAt > Date.now();
}

function wsEncodeText(str) {
  const p = Buffer.from(str, 'utf8');
  let h;
  if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  const mask = crypto.randomBytes(4);
  const m = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) m[i] = p[i] ^ mask[i % 4];
  return Buffer.concat([h, mask, m]);
}

function wsFrameParser(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let maskKey = null;
      if (masked) { if (buf.length < off + 4) return; maskKey = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (maskKey) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ maskKey[i % 4]; payload = u; }
      buf = buf.slice(off + len);
      if (opcode === 1) onMessage(payload.toString('utf8'));
      else if (opcode === 8) { onMessage(null); return; }
    }
  };
}

async function wsConnect() {
  if (wsConn && wsConn.sock && !wsConn.sock.destroyed) return wsConn;
  const u = new URL(WS_URL);
  const key = crypto.randomBytes(16).toString('base64');
  const sock = await new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
      headers: {
        'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        Origin: 'https://shanji.dingtalk.com', 'User-Agent': WS_UA, 'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(CONFIG.wsCookie ? { Cookie: CONFIG.wsCookie } : {}),
      },
    });
    req.on('upgrade', (res, socket) => {
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) { socket.destroy(); reject(new Error('WS 握手校验失败')); return; }
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
  const conn = { sock, pending: new Map(), sid: null, regDone: false };
  wsConn = conn;
  sock.on('data', wsFrameParser((msg) => {
    if (msg === null) {
      const p = conn.pending; conn.pending = new Map();
      for (const fn of p.values()) fn({ error: 'closed' });
      wsConn = null;
      return;
    }
    let m; try { m = JSON.parse(msg); } catch { return; }
    if (m.headers && m.headers.mid) {
      const fn = conn.pending.get(m.headers.mid);
      if (fn) { conn.pending.delete(m.headers.mid); fn(m); }
    }
  }));
  sock.on('error', () => { /* 单次调用的 pending 超时兜底 */ });
  sock.on('close', () => { wsConn = null; });
  return conn;
}

function wsSend(conn, frame, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const mid = frame.headers && frame.headers.mid;
    if (!mid) return reject(new Error('帧缺少 mid'));
    const timer = setTimeout(() => {
      conn.pending.delete(mid);
      try { conn.sock.destroy(); } catch {}
      wsConn = null;
      reject(new Error('WS 调用超时: ' + (frame.lwp || '/!')));
    }, timeoutMs);
    conn.pending.set(mid, (m) => {
      clearTimeout(timer);
      if (m.error) reject(new Error('WS 连接中断'));
      else resolve(m);
    });
    conn.sock.write(wsEncodeText(JSON.stringify(frame)));
  });
}

async function wsReg(conn) {
  if (conn.regDone) return conn;
  const resp = await wsSend(conn, {
    lwp: '/reg',
    headers: {
      referer: WS_REFERER, 'cache-header': 'app-key token ua wv',
      'app-key': CONFIG.wsAppKey || WS_APP_KEY_DEFAULT, token: CONFIG.oauthToken, ua: WS_UA,
      dt: 'j', wv: 'im:0,au:0,sy:6', sync: '0,0;0;0;', 'set-ver': '0', 'reg-type': '1',
      mid: wsMid(),
    },
  }, 15000);
  if (resp.code !== 200) throw new Error('WS 注册失败: ' + JSON.stringify(resp.body || resp).slice(0, 300));
  conn.regDone = true;
  conn.sid = resp.headers && resp.headers.sid;
  return conn;
}

// 业务调用：自动连接 + 注册（注册失败重连一次）+ 发送
async function wsCall(lwp, body, extraHeaders = {}, timeoutMs = 60000) {
  let conn = await wsConnect();
  try {
    await wsReg(conn);
  } catch (e) {
    try { conn.sock.destroy(); } catch {}
    wsConn = null;
    conn = await wsConnect();
    await wsReg(conn);
  }
  const resp = await wsSend(conn, {
    lwp,
    headers: { referer: WS_REFERER, 'TRANSCRIBE-PUBLISH-TYPE': 'normal', ...extraHeaders, mid: wsMid() },
    body,
  }, timeoutMs);
  if (resp.code !== 200) {
    const err = JSON.stringify(resp.body || resp).slice(0, 300);
    throw new Error(`接口失败(${lwp}): ${err}`);
  }
  return resp;
}

// 心跳保活（serve 模式周期调用；CLI 单次调用连接用完即断，无需心跳）
function wsHeartbeat() {
  if (wsConn && wsConn.sock && !wsConn.sock.destroyed) {
    wsSend(wsConn, { lwp: '/!', headers: { referer: WS_REFERER, mid: wsMid() } }, 10000).catch(() => {});
  }
}

// ---------- 页面脚本（CDP 模式） ----------
// 逆向所得：webpack 模块 595047 的 GT = 列表接口；模块 228293 的 K = 通用 LWP 调用
const LIST_SCRIPT = () => `
(async () => {
  const c = window['webpackChunk_ali_flashing_app'];
  if (!c) return JSON.stringify({ error: 'webpack chunk 不存在, 请刷新页面' });
  let req = null;
  c.push([[Math.random().toString(36).slice(2)], {}, function(rr) { req = rr; }]);
  if (!req) return JSON.stringify({ error: '拿不到 require' });
  window.__req = req;
  const mod = req(595047);
  const out = { items: [] };
  let offset = '0';
  let page = 0;
  do {
    const resp = await mod.GT({ pageSize: ${CONFIG.pageSize}, offset, belongingConditionId: 'noLimit', tagId: 'noLimit', sourceConditionIdList: [] });
    const list = resp.itemList || [];
    for (const it of list) {
      out.items.push({ uuid: it.uuid, id: it.id, taskId: it.taskId || it.id, title: it.title, startTime: it.startTime, durationMicros: it.durationMicros || 0, bizType: it.bizType || it.businessType || 2, summary: it.fullTextSummary || '', keywords: (it.keywordsInfo && it.keywordsInfo.keywords) || [] });
    }
    offset = resp.offset;
    page++;
    if (!resp.hasMore || page >= ${CONFIG.maxPages} || !list.length) break;
  } while (true);
  out.total = out.items.length;
  return JSON.stringify(out);
})()`;

const DETAIL_SCRIPT = (item) => `
(async () => {
  const req = window.__req;
  if (!req) return JSON.stringify({ error: 'no req' });
  const K = req(228293).K;
  const out = { summary: '', transcript: '', segments: [] };
  try {
    const detail = await K('/r/Adaptor/PortalMinutesI/minutesDetailV2', [{ taskId: ${item.taskId}, uuid: '${item.uuid}', bizType: ${item.bizType}, enableScreen: true, enableCloudMeeting: true, enableMinutesDetailTab: true, skipLowClientVersionCheck: false }], {});
    const data = detail && detail.data ? detail.data : detail;
    if (data) {
      out.summary = data.summary || data.fullTextSummary || '';
      out.keywords = Array.isArray(data.keywordsInfo) ? data.keywordsInfo : (data.keywordsInfo && data.keywordsInfo.keywords) || [];
      out.title = data.title || '';
    }
  } catch (e) { out.detailError = String(e && e.message || e).slice(0, 200); }
  try {
    let cursor = undefined;
    for (let i = 0; i < 20; i++) {
      const params = { taskUuid: '${item.uuid}', taskId: ${item.taskId}, creator: undefined, pageSize: 50 };
      if (cursor) { params.startTime = cursor.startTime; params.uuid = cursor.uuid; }
      const d = await K('/r/Adaptor/MinutesAppI/minutesParagraphList', [params], {});
      const list = (d && d.itemList) || [];
      for (const p of list) {
        const speaker = (p.speakerDisplayModel && (p.speakerDisplayModel.nickName || p.speakerDisplayModel.nickname)) || p.nickName || '';
        out.segments.push({ speaker, text: p.paragraph || '' });
      }
      if (!list.length) break;
      cursor = { startTime: list[list.length - 1].originalStartTime, uuid: list[list.length - 1].uuid };
    }
  } catch (e) { out.transcriptError = String(e && e.message || e).slice(0, 200); }
  return JSON.stringify(out);
})()`;

// ---------- 数据加工 ----------
// 相邻重复段落去重：钉钉转写偶发同一段话重复几十遍，合并后省体积且提升下游质量
function dedupeSegments(segments) {
  const out = [];
  for (const s of segments) {
    const text = (s.text || '').trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.text === text) { last.dup = (last.dup || 1) + 1; continue; }
    out.push({ speaker: s.speaker || '', text, dup: 1 });
  }
  return { segments: out, transcript: out.map(s => s.text).join('\n') };
}
// 列表条目瘦身（默认不含转写全文，省流量；需要全文用 --full / ?full=1）
function slimIdea(i) {
  return { id: i.id, uuid: i.uuid, title: i.title, startTime: i.startTime, durationMicros: i.durationMicros, summary: i.summary, keywords: i.keywords, createdAt: i.createdAt };
}
function fullIdea(i) {
  return { ...slimIdea(i), transcript: i.transcript, status: i.status };
}

// ---------- 核心取数（双模式分发） ----------
async function cdpFetchList() {
  const raw = await pageEval(LIST_SCRIPT());
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.items;
}
async function wsFetchList() {
  const out = { items: [] };
  let offset = '0';
  for (let page = 0; page < CONFIG.maxPages; page++) {
    const resp = await wsCall('/r/Adaptor/PortalMinutesI/fetchMinutesDataList', [{
      pageSize: CONFIG.pageSize, offset, belongingConditionId: 'noLimit', tagId: 'noLimit', sourceConditionIdList: ['all'],
    }]);
    const list = (resp.body && resp.body.itemList) || [];
    for (const it of list) {
      out.items.push({ uuid: it.uuid, id: it.id, taskId: it.taskId || it.id, title: it.title, startTime: it.startTime, durationMicros: it.durationMicros || 0, bizType: it.bizType || it.businessType || 2, summary: it.fullTextSummary || '', keywords: (it.keywordsInfo && it.keywordsInfo.keywords) || [] });
    }
    offset = resp.body.offset;
    if (!resp.body.hasMore || !list.length) break;
  }
  return out.items;
}
async function fetchList() {
  if (wsModeEnabled()) return wsFetchList();
  return cdpFetchList();
}

async function cdpFetchDetail(item) {
  const raw = await pageEval(DETAIL_SCRIPT(item));
  return JSON.parse(raw);
}
async function wsFetchDetail(item) {
  const out = { summary: '', transcript: '', segments: [], keywords: [], title: '' };
  try {
    const detail = await wsCall('/r/Adaptor/PortalMinutesI/minutesDetailV2', [{
      taskId: item.taskId, uuid: item.uuid, bizType: item.bizType,
      enableScreen: true, enableCloudMeeting: true, enableMinutesDetailTab: true, skipLowClientVersionCheck: false,
    }], {}, 120000);
    const data = detail.body && detail.body.data ? detail.body.data : detail.body;
    if (data) {
      out.summary = data.summary || data.fullTextSummary || '';
      out.keywords = Array.isArray(data.keywordsInfo) ? data.keywordsInfo : (data.keywordsInfo && data.keywordsInfo.keywords) || [];
      out.title = data.title || '';
    }
  } catch (e) { out.detailError = String(e && e.message || e).slice(0, 200); }
  try {
    let cursor;
    for (let i = 0; i < 20; i++) {
      const params = { taskUuid: item.uuid, taskId: item.taskId, pageSize: 50 };
      if (cursor) { params.startTime = cursor.startTime; params.uuid = cursor.uuid; }
      const d = await wsCall('/r/Adaptor/MinutesAppI/minutesParagraphList', [params], {}, 120000);
      const list = (d.body && d.body.itemList) || [];
      for (const p of list) {
        const speaker = (p.speakerDisplayModel && (p.speakerDisplayModel.nickName || p.speakerDisplayModel.nickname)) || p.nickName || '';
        out.segments.push({ speaker, text: p.paragraph || '' });
      }
      if (!list.length) break;
      cursor = { startTime: list[list.length - 1].originalStartTime, uuid: list[list.length - 1].uuid };
    }
  } catch (e) { out.transcriptError = String(e && e.message || e).slice(0, 200); }
  return out;
}
async function fetchDetail(item) {
  const d = wsModeEnabled() ? await wsFetchDetail(item) : await cdpFetchDetail(item);
  if (Array.isArray(d.segments)) {
    const dd = dedupeSegments(d.segments);
    d.segments = dd.segments;
    d.transcript = dd.transcript;
  }
  return d;
}

// 列表拉取失败时自动刷新页面重试一次（页面休眠/chunk 失效是常见故障）
async function fetchListWithRetry(log) {
  try {
    return await fetchList();
  } catch (e) {
    log.push(`列表失败(${e.message.slice(0, 80)})，自动刷新页面重试...`);
    try {
      await cdpReloadPage();
      await sleep(6000);
      const items = await fetchList();
      log.push('刷新页面后重试成功');
      return items;
    } catch (e2) {
      throw new Error('列表拉取失败（已自动刷新重试仍失败）: ' + (e2.message || '').slice(0, 200));
    }
  }
}

// ---------- 同步器 ----------
let syncing = false; // serve 模式并发锁（定时 + 手动可能并发）
async function syncOnce() {
  if (syncing) return { skipped: true };
  syncing = true;
  const log = [];
  try {
    const items = await fetchListWithRetry(log);
    log.push(`列表: ${items.length} 条`);
    let newCount = 0;
    for (const it of items) {
      if (ideaByUuid(it.uuid)) continue;
      try {
        const d = await fetchDetail(it);
        ideas.items.push({
          id: ideas.nextId++,
          uuid: it.uuid,
          title: d.title || it.title,
          startTime: it.startTime,
          durationMicros: it.durationMicros,
          transcript: d.transcript || '',
          summary: it.summary || d.summary || '',
          keywords: d.keywords || it.keywords || [],
          status: 'pending',
          createdAt: Date.now(),
          consumedAt: null,
        });
        newCount++;
        log.push(`  + ${it.title} (${(d.transcript || '').length}字)`);
      } catch (e) {
        log.push(`  ! ${it.title} 详情失败: ${e.message.slice(0, 150)}`);
      }
    }
    if (newCount) saveIdeas();
    state.lastSync = Date.now();
    state.lastSyncCount = newCount;
    state.lastError = null;
    state.consecutiveFailures = 0;
    saveState();
    return { ok: true, newCount, total: ideas.items.length, pending: ideas.items.filter(i => i.status === 'pending').length, log };
  } catch (e) {
    state.lastError = e.message;
    state.lastErrorAt = Date.now();
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    saveState();
    log.push(`同步失败: ${e.message}`);
    if (state.consecutiveFailures >= 3) {
      console.error('============================================================');
      console.error('⚠️  连续同步失败 ' + state.consecutiveFailures + ' 次！请检查:');
      console.error('    1) 浏览器调试窗口是否还开着（重跑 node scripts/index.js up）');
      console.error('    2) 钉钉 AI 听记页面是否需要重新扫码登录');
      console.error('    3) 运行 node scripts/index.js doctor 查看诊断');
      console.error('============================================================');
    }
    return { ok: false, error: e.message, log };
  } finally {
    syncing = false;
  }
}

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
        else flags[key] = true;
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

// ---------- 子命令 ----------
const commands = {
  fetchToken: async () => {
    // 一键式登录: 打开官网浏览器 → 扫码(或已登录自动完成) → 抓 oauth token 存 config → 自动关浏览器
    let startedByUs = false;

    // 1) 确保 Chrome 调试实例在跑并打开 AI 听记页
    let cdpReady = false;
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json`)).json();
      cdpReady = Array.isArray(tabs);
    } catch {}
    if (!cdpReady) {
      const chrome = CONFIG.chromePath || DEFAULT_CHROME;
      const profile = path.join(process.env.TEMP || '.', 'a1-chrome-profile');
      console.log(`启动浏览器(调试端口 ${CONFIG.cdpPort})...`);
      spawn(chrome, [
        `--remote-debugging-port=${CONFIG.cdpPort}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*',
        'https://shanji.dingtalk.com/app/transcribes-list',
      ], { detached: true, stdio: 'ignore' }).unref();
      startedByUs = true;
      for (let i = 0; i < 40; i++) {
        await sleep(1000);
        try { const t = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json`)).json(); if (Array.isArray(t)) { cdpReady = true; break; } } catch {}
      }
    }
    if (!cdpReady) {
      console.error('❌ Chrome 调试实例启动失败，请手动运行 node scripts/index.js up');
      return shutdown(1);
    }
    console.log('✅ 浏览器已打开 AI 听记页面');
    console.log('   若弹出钉钉登录页，请用手机钉钉扫码登录（只需一次）；若已登录会自动完成');
    console.log('   正在等待登录完成（最长 3 分钟）...');

    // 2) 轮询等待 account cookie(oauth_k1) 出现 = 登录成功
    let acct = null;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      try {
        const cookies = await cdpGetCookies();
        acct = cookies.find(c => c.name === 'account' && c.domain === '.dingtalk.com' && c.value.includes('oauth_k1'));
        if (acct) break;
      } catch {}
      if (i > 0 && i % 15 === 0) console.log(`   等待中... (${Math.round(i * 2 / 60)} 分钟)`);
    }
    if (!acct) {
      console.error('❌ 等待登录超时（3 分钟），未检测到登录状态');
      if (startedByUs) { try { execSync(`taskkill /pid ${findChromePid(CONFIG.cdpPort)} /f /t 2>nul`, { shell: 'cmd.exe' }); } catch {} }
      return shutdown(1);
    }

    // 3) 抓取并保存 token
    const oauthToken = decodeURIComponent(acct.value);
    if (!oauthToken.startsWith('oauth_k1:')) {
      console.error('❌ account cookie 格式异常:', oauthToken.slice(0, 50));
      return shutdown(1);
    }
    const wsCookie = (await cdpGetCookies())
      .filter(c => /\.dingtalk\.com$/.test(c.domain) || /^shanji\.dingtalk\.com$/.test(c.domain))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    // account cookie 多为会话级 cookie（CDP 返回 expires = -1），此时无从得知过期时间，
    // 记为 0（未知 → 按有效处理），auto 模式才会走 WS 直连；失效后重跑 fetch-token 即可。
    const expireAt = acct.expires && acct.expires > 0 ? Math.round(acct.expires * 1000) : 0;
    const cfg = { ...CONFIG, oauthToken, oauthTokenExpireAt: expireAt, wsCookie, mode: CONFIG.mode || 'auto' };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log(`✅ oauth token 已保存至 ${CONFIG_PATH}`);
    console.log(expireAt > 0
      ? `   有效期至: ${fmtTime(expireAt)}（约 ${Math.max(1, Math.round((expireAt - Date.now()) / 86400000))} 天）`
      : '   有效期: 会话级 token（cookie 未标注过期时间，按有效处理；失效后重跑本命令续期）');

    // 4) 关闭浏览器（仅当是本命令启动的）
    if (startedByUs) {
      try { execSync(`taskkill /pid ${findChromePid(CONFIG.cdpPort)} /f /t 2>nul`, { shell: 'cmd.exe' }); } catch {}
      console.log('✅ 浏览器已自动关闭');
    } else {
      console.log('ℹ️  浏览器此前已在运行，请手动关闭调试窗口');
    }

    // 5) 验证 WS 直连（更新内存 CONFIG 后直接测）
    CONFIG.oauthToken = oauthToken;
    CONFIG.wsCookie = wsCookie;
    CONFIG.oauthTokenExpireAt = expireAt;
    try {
      const items = await wsFetchList();
      console.log(`✅ WS 直连验证通过: 列表 ${items.length} 条 | 当前模式: WS 直连（无浏览器）`);
    } catch (e) {
      console.log(`⚠️  WS 直连验证失败: ${e.message.slice(0, 150)}（token 已保存，可用 doctor 排查）`);
    }
  },

  doctor: async ({ flags }) => {
    const out = { chrome: false, page: false, chromePort: CONFIG.cdpPort, ideasFile: IDEAS_FILE, ideasFileExists: fs.existsSync(IDEAS_FILE), lastSync: state.lastSync, lastError: state.lastError, consecutiveFailures: state.consecutiveFailures || 0 };
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json`)).json();
      out.chrome = true;
      out.tabCount = tabs.filter(t => t.type === 'page').length;
      const page = tabs.find(t => t.type === 'page' && t.url.includes('shanji.dingtalk.com'));
      out.page = !!page;
      if (page) {
        out.pageUrl = page.url;
        try {
          const raw = await pageEval(`JSON.stringify((() => { try { const j = JSON.parse(localStorage.getItem('we-flashing://aiAgentToken/token') || '{}'); return { authed: !!(j && j.token), tokenHead: (j.token || '').slice(0, 12), expireAt: j.expireAt || 0, expired: !!(j.expireAt && j.expireAt < Date.now()) }; } catch (e) { return { authed: false, parseError: String(e && e.message || e).slice(0, 80) }; } })())`);
          const p = JSON.parse(raw);
          out.login = p.authed;
          out.tokenExpired = p.expired;
          out.tokenExpireAt = p.expireAt;
        } catch (e) { out.login = false; out.pageEvalError = e.message; }
      }
    } catch (e) {
      out.chromeError = e.message;
    }
    out.totalIdeas = ideas.items.length;
    out.pendingIdeas = ideas.items.filter(i => i.status === 'pending').length;
    if (flags.json) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log('===== 环境诊断 =====');
    const wsMode = wsModeEnabled();
    console.log(`运行模式: ${wsMode ? 'WS 直连（无浏览器）✅' : 'CDP（浏览器）'}${wsMode ? '' : (CONFIG.oauthToken ? '（token 已过期，重跑 fetch-token 续期）' : '（未配置 token，运行 fetch-token 可开启无浏览器模式）')}`);
    console.log(`Chrome 调试实例(${CONFIG.cdpPort}): ${out.chrome ? '✅ 运行中' : '❌ 未运行'} ${out.chromeError ? '— ' + out.chromeError : ''}`);
    console.log(`AI 听记页面: ${out.page ? '✅ 已打开' : '❌ 未找到'}${out.pageUrl ? ' (' + out.pageUrl + ')' : ''}`);
    if (out.page) {
      const tokenState = !out.login ? '❌ 无 token' : (out.tokenExpired ? '⚠️ token 已过期' : '✅ 有效');
      console.log(`登录状态: ${tokenState}${out.tokenExpireAt ? ' (过期于 ' + fmtTime(out.tokenExpireAt) + ')' : ''}`);
    }
    console.log(`想法库: ${IDEAS_FILE}`);
    console.log(`  总数 ${out.totalIdeas} 条 | 待处理 ${out.pendingIdeas} 条`);
    console.log(`上次同步: ${fmtTime(out.lastSync)}${out.lastError ? ' | ⚠️ ' + out.lastError : ''}`);
    if (out.consecutiveFailures >= 3) console.log(`⚠️  连续同步失败 ${out.consecutiveFailures} 次，请检查浏览器登录态`);
    if (!out.chrome && !wsMode) console.log('\n💡 请先运行: node scripts/index.js up（或 fetch-token）');
  },

  sync: async ({ flags }) => {
    if (flags.json) {
      const r = await syncOnce();
      console.log(JSON.stringify(r, null, 2));
      return shutdown(r.ok ? 0 : 1);
    }
    console.log('正在同步钉钉 AI 听记...');
    const r = await syncOnce();
    if (r.log && r.log.length) for (const l of r.log) console.log(l);
    if (r.ok) console.log(`✅ 同步完成: 新增 ${r.newCount} 条 | 库内共 ${r.total} 条 | 待处理 ${r.pending}`);
    else console.error(`❌ 同步失败: ${r.error}`);
    return shutdown(r.ok ? 0 : 1);
  },

  list: async ({ flags }) => {
    const after = Number(flags.after) || 0;
    const limit = Math.min(Number(flags.limit) || 20, 100);
    const full = !!flags.full;
    const items = ideas.items
      .filter(i => i.status === 'pending' && i.id > after)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map(full ? fullIdea : slimIdea);
    const nextAfter = items.length ? items[items.length - 1].id : after;
    if (flags.json) {
      console.log(JSON.stringify({ items, after: nextAfter, total: ideas.items.filter(i => i.status === 'pending').length, full }, null, 2));
      return;
    }
    if (!items.length) { console.log('(没有待处理的想法)'); return; }
    for (const it of items) {
      console.log(`[${it.id}] ${it.title} | ${fmtTime(it.startTime)} | ${fmtDur(it.durationMicros)}`);
      if (it.summary) console.log(`    摘要: ${it.summary.slice(0, 120)}${it.summary.length > 120 ? '...' : ''}`);
      if (full && it.transcript) console.log(`    转写: ${it.transcript.slice(0, 100).replace(/\n/g, ' ')}${it.transcript.length > 100 ? '...' : ''}`);
    }
    console.log(`\n共 ${items.length} 条, 下次游标 after=${nextAfter}${full ? '' : ' (转写全文用 --full 或 get <id>)'}`);
  },

  get: async ({ flags, rest }) => {
    const id = Number(rest[0]);
    if (!id) { console.error('用法: node scripts/index.js get <id> [--json]'); return shutdown(1); }
    const item = ideas.items.find(i => i.id === id);
    if (!item) { console.error(`未找到 id=${id}`); return shutdown(1); }
    if (flags.json) { console.log(JSON.stringify(item, null, 2)); return; }
    console.log(`===== [${item.id}] ${item.title} =====`);
    console.log(`时间: ${fmtTime(item.startTime)} | 时长: ${fmtDur(item.durationMicros)} | 状态: ${item.status}`);
    if (item.keywords && item.keywords.length) console.log(`关键词: ${item.keywords.join(' / ')}`);
    console.log(`\n----- AI 摘要 -----\n${item.summary || '(无)'}`);
    console.log(`\n----- 转写全文 (${item.transcript.length}字) -----\n${item.transcript || '(无)'}`);
  },

  consume: async ({ rest }) => {
    const id = Number(rest[0]);
    if (!id) { console.error('用法: node scripts/index.js consume <id>'); return shutdown(1); }
    const item = ideas.items.find(i => i.id === id);
    if (!item) { console.error(`未找到 id=${id}`); return shutdown(1); }
    if (item.status === 'consumed') { console.log(`id=${id} 已经是已消费状态`); return; }
    item.status = 'consumed';
    item.consumedAt = Date.now();
    saveIdeas();
    console.log(`✅ [${id}] ${item.title} 已标记为已消费`);
  },

  refresh: async ({ flags }) => {
    // 用列表接口回填已有条目的 summary / keywords（syncOnce 跳过已存在条目，故需要单独刷新）
    const items = await fetchListWithRetry([]);
    const byUuid = new Map(items.map(i => [i.uuid, i]));
    let fixed = 0;
    for (const item of ideas.items) {
      const fresh = byUuid.get(item.uuid);
      if (!fresh) continue;
      let changed = false;
      if (fresh.summary && fresh.summary !== item.summary) { item.summary = fresh.summary; changed = true; }
      if (fresh.keywords && fresh.keywords.length && JSON.stringify(fresh.keywords) !== JSON.stringify(item.keywords)) { item.keywords = fresh.keywords; changed = true; }
      if (changed) fixed++;
    }
    if (fixed) saveIdeas();
    const out = { ok: true, updated: fixed, total: ideas.items.length };
    if (flags.json) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log(`✅ 回填完成: 更新 ${fixed} 条摘要/关键词（库内共 ${ideas.items.length} 条）`);
  },

  status: async ({ flags }) => {
    const out = {
      ok: true,
      total: ideas.items.length,
      pending: ideas.items.filter(i => i.status === 'pending').length,
      consumed: ideas.items.filter(i => i.status === 'consumed').length,
      lastSync: state.lastSync,
      lastSyncCount: state.lastSyncCount,
      lastError: state.lastError,
      consecutiveFailures: state.consecutiveFailures || 0,
    };
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json`)).json();
      out.chrome = tabs.some(t => t.type === 'page' && t.url.includes('shanji'));
    } catch { out.chrome = false; out.ok = false; }
    if (flags.json) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log(`Chrome: ${out.chrome ? '✅' : '❌'} | 模式: ${wsModeEnabled() ? 'WS直连' : 'CDP'} | 想法库: ${out.total} 条 (待处理 ${out.pending} / 已消费 ${out.consumed})`);
    console.log(`上次同步: ${fmtTime(out.lastSync)} (新增 ${out.lastSyncCount || 0} 条)${out.lastError ? ' | ⚠️ ' + out.lastError : ''}`);
    if (out.consecutiveFailures >= 3) console.log(`⚠️  连续同步失败 ${out.consecutiveFailures} 次，请检查浏览器登录态`);
  },

  serve: async ({ flags }) => {
    // HTTP API 服务（并发锁 / ideas / consume / sync / health）
    const port = Number(flags.port) || CONFIG.port;
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const p = url.pathname;
        const authOk = (req.headers['authorization'] || '') === `Bearer ${CONFIG.apiToken}`;
        if (p !== '/api/health' && !authOk) { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'unauthorized', hint: 'Authorization: Bearer <token>' })); return; }
        if (p === '/api/health') {
          let chrome = false;
          try { const t = await (await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json`)).json(); chrome = t.some(x => x.type === 'page' && x.url.includes('shanji')); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, chromeConnected: chrome, lastSync: state.lastSync, lastError: state.lastError, consecutiveFailures: state.consecutiveFailures || 0, pendingCount: ideas.items.filter(i => i.status === 'pending').length, totalCount: ideas.items.length }));
        } else if (p === '/api/ideas' && req.method === 'GET') {
          const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
          const after = Number(url.searchParams.get('after')) || 0;
          const full = url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true';
          const items = ideas.items.filter(i => i.status === 'pending' && i.id > after).sort((a, b) => a.id - b.id).slice(0, limit)
            .map(full ? fullIdea : slimIdea);
          const nextAfter = items.length ? items[items.length - 1].id : after;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ items, after: nextAfter, total: ideas.items.filter(i => i.status === 'pending').length, full }));
        } else if (p === '/api/ideas/all' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ items: ideas.items }));
        } else if (p.startsWith('/api/ideas/') && p.endsWith('/consume') && req.method === 'POST') {
          const id = Number(p.split('/')[3]);
          const item = ideas.items.find(i => i.id === id);
          if (!item) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'not found' })); return; }
          item.status = 'consumed'; item.consumedAt = Date.now(); saveIdeas();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, id }));
        } else if (p === '/api/sync' && req.method === 'POST') {
          const r = await syncOnce();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r));
        } else { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'not found' })); }
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: e.message })); }
    });
    server.on('error', (e) => {
      console.error(`[serve] ❌ 端口 ${port} 启动失败: ${e.message}`);
      console.error(`[serve]    若端口被占用，可用 --port <其他端口> 指定`);
      return shutdown(1);
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[serve] HTTP API 已启动 http://127.0.0.1:${port}`);
      console.log(`[serve] API Token: ${CONFIG.apiToken}`);
      console.log(`[serve] 首次同步...`);
      syncOnce().then(r => {
        if (r.ok) console.log(`[serve] 同步完成: 新增 ${r.newCount || 0} 条`);
        else if (!r.skipped) console.error(`[serve] 首次同步失败: ${r.error}`);
      }).catch(e => console.error('[serve] 首次同步异常:', e.message));
    });
    setInterval(() => {
      syncOnce().then(r => {
        if (!r.ok && !r.skipped) console.error(`[serve] 定时同步失败: ${r.error}`);
      }).catch(e => console.error('[serve] 定时同步异常:', e.message));
    }, CONFIG.pollIntervalSec * 1000);
    // WS 直连模式心跳保活（CDP 模式无副作用）
    setInterval(wsHeartbeat, 30000);
    // serve 常驻：永不返回
    return new Promise(() => {});
  },

  up: async ({ flags }) => {
    // 确保浏览器调试实例在跑（无则拉起）再启动服务；WS 直连模式无需浏览器
    if (wsModeEnabled()) {
      console.log('ℹ️  检测到有效的 WS 直连 token，无需浏览器，直接启动服务。');
    } else {
      const ok = await ensureChrome();
      if (!ok) {
        console.error('❌ 无法启动 Chrome 调试实例（未找到 Chrome/Edge 或启动失败）');
        console.error(`   请确认已安装浏览器，或手动启动：chrome --remote-debugging-port=${CONFIG.cdpPort} --user-data-dir="%TEMP%\\a1-chrome-profile" --remote-allow-origins=* https://shanji.dingtalk.com`);
        return shutdown(1);
      }
      console.log(`✅ 浏览器调试实例就绪（端口 ${CONFIG.cdpPort}）`);
      console.log('   若弹出钉钉登录页，请扫码登录 AI 听记（只需一次）；若已登录会自动完成。');
    }
    return commands.serve({ flags });
  },
};

// ---------- 入口 ----------
// CLI 是一次性命令：CDP/WS 连接复用后事件循环被 WebSocket 保持，
// 命令完成后必须显式退出（serve 除外——它自己返回永不结束的 Promise）。
// Windows 上 process.exit 时若 WS 正在关闭会撞 uv 断言，先关连接再退出。
let _exiting = false;
function shutdown(code) {
  if (_exiting) return;
  _exiting = true;
  for (const entry of wsCache.values()) {
    try { entry.ws.close(); } catch {}
  }
  if (wsConn && wsConn.sock) { try { wsConn.sock.destroy(); } catch {} }
  setTimeout(() => process.exit(code), 50);
}

function printHelp() {
  console.log(`index — 钉钉 A1 听记桥接（单文件零依赖）

用法: node scripts/index.js <命令> [选项]

命令:
  fetch-token     一键登录: 开浏览器→扫码(或已登录直接完成)→保存 token→自动关浏览器 (约 30 天一次)
  doctor          环境诊断（模式/Chrome/登录/存储）
  sync [--json]   增量同步新听记
  list [--after N] [--limit N] [--json] [--full]   列出待处理想法（默认不含转写全文, --full 含）
  get <id> [--json]    查看单条详情（含转写全文）
  consume <id>    标记已消费
  refresh [--json]     用列表接口回填已有条目的摘要/关键词
  status [--json] 状态概览
  serve [--port N]     启动 HTTP API 服务（常驻）
  up [--port N]        确保浏览器调试实例在跑（无则拉起）再启动服务

示例:
  node scripts/index.js fetch-token
  node scripts/index.js doctor
  node scripts/index.js sync
  node scripts/index.js list --json
  node scripts/index.js list --full --json | jq '.items[0].transcript'
  node scripts/index.js get 1
`);
}

async function main() {
  await ensureConfig();
  CONFIG = loadConfig();

  const argv = process.argv.slice(2);
  const raw = argv[0];
  if (!raw || raw === 'help' || raw === '-h' || raw === '--help') { printHelp(); return shutdown(0); }
  // 兼容连字符写法: fetch-token -> fetchToken
  const cmd = raw.includes('-') ? raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : raw;
  if (!commands[cmd]) { printHelp(); return shutdown(1); }
  const { flags, rest } = parseArgs(argv.slice(1));
  await commands[cmd]({ flags, rest });
}

main()
  .then(() => shutdown(0))
  .catch(e => { console.error(`❌ 错误: ${e.message}`); shutdown(1); });
