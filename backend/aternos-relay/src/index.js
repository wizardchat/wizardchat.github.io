const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { fork } = require('node:child_process');

const PORT = Number(process.env.PORT || 3000);
const ATERNOS_USER = process.env.ATERNOS_USER || '';
const ATERNOS_PASSWORD = process.env.ATERNOS_PASSWORD || '';
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const ATERNOS_SERVER_ID = process.env.ATERNOS_SERVER_ID || '';
const ATERNOS_SERVER_NAME = process.env.ATERNOS_SERVER_NAME || '';
const MC_HOST = process.env.MC_HOST || 'school-cra.aternos.me';
const MC_PORT = process.env.MC_PORT || '40531';
const STATUS_CACHE_MS = Number(process.env.STATUS_CACHE_MS || 10000);
const ATERNOS_INFO_TTL_MS = Number(process.env.ATERNOS_INFO_TTL_MS || 30000);
const COOKIE_TTL_MS = Number(process.env.COOKIE_TTL_MS || 15 * 60 * 1000);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 11000);
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS || 35000);

const haveCreds = !!(ATERNOS_USER && ATERNOS_PASSWORD);
const WORKER = path.join(__dirname, 'worker.js');

function runWorker(task, opts = {}, timeoutMs = RUN_TIMEOUT_MS + 5000) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    if (opts.cookies) env.ATERNOS_COOKIES = Buffer.from(JSON.stringify(opts.cookies)).toString('base64');
    let stdout = '';
    let settled = false;
    const child = fork(WORKER, [task], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ error: `${task} timed out` });
    }, timeoutMs);
    child.on('error', () => settle({ error: 'worker failed to spawn' }));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('exit', (code) => {
      try {
        settle(JSON.parse(stdout));
      } catch {
        settle({ error: `worker ${task} exited ${code}: ${stdout.slice(0, 240) || 'no output'}` });
      }
    });
  });
}

let cookieCache = null;
let cookieAt = 0;
let loginFlight = null;

async function getCookies() {
  if (cookieCache && Date.now() - cookieAt < COOKIE_TTL_MS) return cookieCache;
  if (!loginFlight) {
    loginFlight = runWorker('login', {}, LOGIN_TIMEOUT_MS)
      .then((result) => {
        if (result && Array.isArray(result.cookies)) {
          cookieCache = result.cookies;
          cookieAt = Date.now();
          return result.cookies;
        }
        throw new Error((result && result.error) || 'login failed');
      })
      .finally(() => {
        loginFlight = null;
      });
  }
  return loginFlight;
}

function pickServer(servers) {
  if (!servers || servers.length === 0) return null;
  if (ATERNOS_SERVER_ID) {
    const match = servers.find((s) => s.id && ATERNOS_SERVER_ID.toLowerCase() === s.id.toLowerCase());
    if (match) return match;
  }
  if (ATERNOS_SERVER_NAME) {
    const match = servers.find((s) => s.name && s.name.toLowerCase().includes(ATERNOS_SERVER_NAME.toLowerCase()));
    if (match) return match;
  }
  return servers[0];
}

let infoCache = null;
let infoAt = 0;

async function aternosServerInfo() {
  if (infoCache && Date.now() - infoAt < ATERNOS_INFO_TTL_MS) return infoCache;
  try {
    const cookies = await getCookies();
    const result = await runWorker('server', { cookies });
    if (result && Array.isArray(result.servers)) {
      const picked = pickServer(result.servers);
      infoCache = { server: picked, error: null };
      infoAt = Date.now();
      return infoCache;
    }
    return { server: null, error: (result && result.error) || 'getServerList failed' };
  } catch (err) {
    return { server: null, error: String(err && err.message ? err.message : err) };
  }
}

async function fetchMcStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  timer.unref?.();
  try {
    const url = `https://api.mcsrvstat.us/3/${encodeURIComponent(MC_HOST)}:${MC_PORT}`;
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`mcsrvstat ${res.status}`);
    const data = await res.json();
    const online = data && data.online === true;
    const players = data && data.players ? { now: data.players.online, max: data.players.max } : null;
    return {
      online,
      players,
      address: (data && data.hostname) || null,
      port: data && data.port != null ? String(data.port) : null,
      version: (data && data.version) || null,
    };
  } catch (err) {
    return { error: err && err.name === 'AbortError' ? 'mcsrvstat timed out' : String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

let statusCache = null;
let statusAt = 0;

async function computeStatus() {
  const [mc, aternos] = await Promise.all([
    fetchMcStatus().catch(() => ({})),
    haveCreds ? aternosServerInfo() : Promise.resolve({}),
  ]);

  const online = mc.online === true;
  const transient = ['starting', 'stopping', 'loaded', 'loading', 'initializing'];
  let status = online ? 'online' : 'offline';
  if (!online && aternos.server && transient.includes(String(aternos.server.status))) {
    status = String(aternos.server.status);
  }

  return {
    ok: true,
    source: haveCreds ? 'aternos' : 'mcsrvstat',
    status,
    online,
    address: mc.address || (aternos.server && aternos.server.name) || null,
    port: mc.port || null,
    software: (aternos.server && aternos.server.software) || null,
    version: mc.version || null,
    playersText:
      mc.players != null
        ? `${mc.players.now} / ${mc.players.max}`
        : aternos.server && aternos.server.players
          ? String(aternos.server.players)
          : null,
    players: mc.players || null,
    ram: null,
    message: aternos.error ? `aternos: ${aternos.error}` : null,
  };
}

async function status() {
  if (statusCache && Date.now() - statusAt < STATUS_CACHE_MS) return statusCache;
  statusCache = await computeStatus();
  statusAt = Date.now();
  return statusCache;
}

function clearCaches() {
  statusCache = null;
  infoCache = null;
}

function authorize(req) {
  if (!RELAY_TOKEN) return { error: 'RELAY_TOKEN is not configured on this relay' };
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!supplied) return { error: 'missing Bearer token' };
  const a = Buffer.from(supplied);
  const b = Buffer.from(RELAY_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'invalid token' };
  return {};
}

async function action(task) {
  if (!haveCreds) return { success: false, status: null, message: 'Aternos credentials are not configured' };
  try {
    const cookies = await getCookies();
    if (!ATERNOS_SERVER_ID && !ATERNOS_SERVER_NAME) {
      const info = await aternosServerInfo();
      if (!info.server) return { success: false, status: null, message: info.error || 'no matching server' };
    }
    const result = await runWorker(task, { cookies });
    if (result && result.result) {
      return result.result;
    }
    return { success: false, status: null, message: (result && result.error) || `${task} failed` };
  } catch (err) {
    return { success: false, status: null, message: String(err && err.message ? err.message : err) };
  } finally {
    clearCaches();
  }
}

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && pathname === '/config') {
      return send(res, 200, {
        ok: true,
        configured: haveCreds,
        serverId: ATERNOS_SERVER_ID || null,
        serverName: ATERNOS_SERVER_NAME || null,
        mcHost: MC_HOST,
        mcPort: MC_PORT,
        statusCacheMs: STATUS_CACHE_MS,
      });
    }
    if (req.method === 'GET' && pathname === '/status') return send(res, 200, await status());

    if (pathname === '/start' || pathname === '/stop') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'POST, OPTIONS' });
        return res.end();
      }
      if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'method not allowed' });
      const auth = authorize(req);
      if (auth.error) return send(res, 401, { ok: false, success: false, message: auth.error });
      await parseBody(req);
      const task = pathname === '/start' ? 'start' : 'stop';
      const result = await action(task);
      return send(res, 200, Object.assign({ ok: true }, result));
    }

    return send(res, 404, { ok: false, message: 'not found' });
  } catch (err) {
    return send(res, 500, { ok: false, success: false, message: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, () => {
  console.log(
    `[aternos-relay] listening on :${PORT} creds=${haveCreds ? 'yes' : 'no'} target=${MC_HOST}:${MC_PORT}`,
  );
});