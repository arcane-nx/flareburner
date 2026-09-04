import http from 'http';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import {
  BrowserPool,
  SessionManager,
  connectBrowser,
  navigate,
  buildResult,
  fetchFastPath,
  fetchBinaryFastPath,
  fetchProxyFastPath,
  waitForCloudflare,
  isTransientNavError,
} from './index.js';

// ---------------------------------------------------------------------------
// Config: .env file (if present) < process.env < CLI port arg.
// ---------------------------------------------------------------------------
function loadEnv() {
  const merged = { ...process.env };
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env'),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p));
  if (envPath) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in merged)) merged[key] = val;
    }
  }
  return merged;
}

const env = loadEnv();
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const bool = (v, d) => (v == null ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const config = {
  port: num(process.argv[2], num(env.PORT, 4001)),
  apiKey: env.API_KEY || '',
  poolSize: num(env.POOL_SIZE, 1),
  headless: bool(env.HEADLESS, false),
  navTimeout: num(env.NAV_TIMEOUT, 60000),
  defaultUrl: env.DEFAULT_URL || 'https://nowsecure.nl',
  maxBodySize: num(env.MAX_BODY_SIZE, 2 * 1024 * 1024),
  proxyUrl: env.PROXY_URL || '',
  maxRequestsPerSlot: num(env.MAX_REQUESTS_PER_SLOT, 50),
  maxSlotLifetimeMs: num(env.MAX_SLOT_LIFETIME_MS, 3600000),
  sessionTtl: num(env.SESSION_TTL, 900000),
  blockResources: bool(env.BLOCK_RESOURCES, false),
};

// ---------------------------------------------------------------------------
// Prometheus & Operational Metrics Collector
// ---------------------------------------------------------------------------
class MetricsCollector {
  constructor() {
    this.httpRequests = new Map(); // `${endpoint}|${method}|${status}` -> count
    this.fsCommands = new Map();   // `${cmd}|${status}` -> count
    this.fastPath = new Map();     // `${type}|${result}` -> count
    this.solveTimes = [];          // keep last 50 solve times in seconds
    this.lastSolveTime = 0;
  }

  incHttp(endpoint, method, status) {
    const key = `${endpoint}|${method}|${status}`;
    this.httpRequests.set(key, (this.httpRequests.get(key) || 0) + 1);
  }

  incFs(cmd, status) {
    const key = `${cmd}|${status}`;
    this.fsCommands.set(key, (this.fsCommands.get(key) || 0) + 1);
  }

  incFastPath(type, result) {
    const key = `${type}|${result}`;
    this.fastPath.set(key, (this.fastPath.get(key) || 0) + 1);
  }

  recordSolveTime(durationSec) {
    this.lastSolveTime = Number(durationSec.toFixed(3));
    this.solveTimes.push(this.lastSolveTime);
    if (this.solveTimes.length > 50) this.solveTimes.shift();
  }

  getSolveAvg() {
    if (!this.solveTimes.length) return 0;
    const sum = this.solveTimes.reduce((acc, v) => acc + v, 0);
    return Number((sum / this.solveTimes.length).toFixed(3));
  }

  summary() {
    let totalReqs = 0;
    for (const v of this.httpRequests.values()) totalReqs += v;
    let totalFs = 0;
    for (const v of this.fsCommands.values()) totalFs += v;
    return {
      totalHttpRequests: totalReqs,
      totalFlareSolverrCommands: totalFs,
      lastSolveTimeSeconds: this.lastSolveTime,
      avgSolveTimeSeconds: this.getSolveAvg(),
    };
  }

  toPrometheusText({ uptimeSeconds, poolStats, activeSessions, clearanceCacheSize }) {
    const lines = [];

    lines.push('# HELP flareburner_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE flareburner_uptime_seconds gauge');
    lines.push(`flareburner_uptime_seconds ${uptimeSeconds}`);
    lines.push('');

    lines.push('# HELP flareburner_http_requests_total Total number of HTTP requests processed');
    lines.push('# TYPE flareburner_http_requests_total counter');
    if (this.httpRequests.size === 0) {
      lines.push('flareburner_http_requests_total{endpoint="/",method="GET",status="200"} 0');
    } else {
      for (const [key, count] of this.httpRequests.entries()) {
        const [endpoint, method, status] = key.split('|');
        lines.push(`flareburner_http_requests_total{endpoint="${endpoint}",method="${method}",status="${status}"} ${count}`);
      }
    }
    lines.push('');

    lines.push('# HELP flareburner_flaresolverr_commands_total Total FlareSolverr commands processed');
    lines.push('# TYPE flareburner_flaresolverr_commands_total counter');
    if (this.fsCommands.size === 0) {
      lines.push('flareburner_flaresolverr_commands_total{cmd="none",status="ok"} 0');
    } else {
      for (const [key, count] of this.fsCommands.entries()) {
        const [cmd, status] = key.split('|');
        lines.push(`flareburner_flaresolverr_commands_total{cmd="${cmd}",status="${status}"} ${count}`);
      }
    }
    lines.push('');

    lines.push('# HELP flareburner_fastpath_hits_total Total fast-path cache hits and misses');
    lines.push('# TYPE flareburner_fastpath_hits_total counter');
    if (this.fastPath.size === 0) {
      lines.push('flareburner_fastpath_hits_total{type="scrape",result="hit"} 0');
    } else {
      for (const [key, count] of this.fastPath.entries()) {
        const [type, result] = key.split('|');
        lines.push(`flareburner_fastpath_hits_total{type="${type}",result="${result}"} ${count}`);
      }
    }
    lines.push('');

    lines.push('# HELP flareburner_browser_pool_slots Browser pool slot status');
    lines.push('# TYPE flareburner_browser_pool_slots gauge');
    lines.push(`flareburner_browser_pool_slots{state="total"} ${poolStats.size}`);
    lines.push(`flareburner_browser_pool_slots{state="busy"} ${poolStats.busy}`);
    lines.push(`flareburner_browser_pool_slots{state="idle"} ${Math.max(0, poolStats.size - poolStats.busy)}`);
    lines.push(`flareburner_browser_pool_slots{state="waiting"} ${poolStats.waiting || 0}`);
    lines.push('');

    lines.push('# HELP flareburner_active_sessions Number of active stateful sessions');
    lines.push('# TYPE flareburner_active_sessions gauge');
    lines.push(`flareburner_active_sessions ${activeSessions}`);
    lines.push('');

    lines.push('# HELP flareburner_clearance_cache_size Number of origins in clearance cache');
    lines.push('# TYPE flareburner_clearance_cache_size gauge');
    lines.push(`flareburner_clearance_cache_size ${clearanceCacheSize}`);
    lines.push('');

    lines.push('# HELP flareburner_solve_duration_seconds FlareSolverr / scraping solve duration in seconds');
    lines.push('# TYPE flareburner_solve_duration_seconds gauge');
    lines.push(`flareburner_solve_duration_seconds{type="last"} ${this.lastSolveTime}`);
    lines.push(`flareburner_solve_duration_seconds{type="avg"} ${this.getSolveAvg()}`);
    lines.push('');

    return lines.join('\n');
  }
}

const startedAt = Date.now();
const metrics = new MetricsCollector();

const pool = new BrowserPool({
  size: config.poolSize,
  headless: config.headless,
  proxy: config.proxyUrl,
  maxRequestsPerSlot: config.maxRequestsPerSlot,
  maxSlotLifetimeMs: config.maxSlotLifetimeMs,
});

const sessionManager = new SessionManager({
  ttl: config.sessionTtl,
  headless: config.headless,
  defaultProxy: config.proxyUrl,
});

// Origin-specific Cloudflare clearance cache (origin -> { cookies, userAgent, updatedAt }).
// Lets /binary and /fetch endpoints fetch protected resources via a plain HTTP fetch
// using clearance harvested for that specific origin.
const clearanceCache = new Map();
const MAX_CLEARANCE_ENTRIES = 100;

function rememberClearance(url, cookies, userAgent) {
  if (!Array.isArray(cookies) || !cookies.length || !url) return;
  try {
    const origin = new URL(url).origin;
    const prev = clearanceCache.get(origin);
    clearanceCache.set(origin, {
      cookies,
      userAgent: userAgent || prev?.userAgent || null,
      updatedAt: Date.now(),
    });
    if (clearanceCache.size > MAX_CLEARANCE_ENTRIES) {
      const oldestKey = clearanceCache.keys().next().value;
      clearanceCache.delete(oldestKey);
    }
  } catch {
    // Ignore unparseable URLs
  }
}

function getClearance(url) {
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    if (clearanceCache.has(origin)) {
      return clearanceCache.get(origin);
    }
    // Subdomain fallback: if a cached entry has cookies whose domain matches the target host
    const host = parsed.hostname;
    for (const entry of clearanceCache.values()) {
      if (
        entry.cookies &&
        entry.cookies.some((c) => {
          if (!c.domain) return false;
          const cleanDomain = c.domain.replace(/^\./, '');
          return host === cleanDomain || host.endsWith('.' + cleanDomain);
        })
      ) {
        return entry;
      }
    }
  } catch {
    // Ignore unparseable URLs
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isValidHttpUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) return false;
  try {
    const parsed = new URL(urlString.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

class PayloadTooLargeError extends Error {
  constructor(message = 'Request body too large') {
    super(message);
    this.name = 'PayloadTooLargeError';
    this.statusCode = 413;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendBinary(res, status, buffer, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': buffer.length,
    // images are immutable content-addressed assets; let the caller cache hard
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(buffer);
}

function readBody(req, limit = config.maxBodySize) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let size = 0;

    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        settled = true;
        cleanup();
        req.destroy();
        reject(new PayloadTooLargeError(`Request body exceeded limit of ${limit} bytes`));
      } else {
        chunks.push(buf);
      }
    };

    const onEnd = () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };

    const onError = (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

async function parseJsonBody(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError || err.statusCode === 413) {
      sendJson(res, 413, { error: err.message });
      return null;
    }
    sendJson(res, 400, { error: 'Failed to read request body' });
    return null;
  }

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return null;
  }
}

function authorized(req) {
  if (!config.apiKey) return true;
  const header = req.headers['x-api-key'] || '';
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return header === config.apiKey || bearer === config.apiKey;
}

/**
 * Runs a scrape: tries the cookie fast-path first (when eligible), otherwise
 * leases a warm browser from the pool.
 */
async function scrape(opts) {
  const {
    url,
    cookies,
    userAgent,
    headers,
    returnType = 'full',
    screenshot = false,
    waitUntil = 'domcontentloaded',
    waitForSelector,
    timeout = config.navTimeout,
    fastPath = true,
    blockResources = config.blockResources,
  } = opts;

  // Fast-path: plain fetch with supplied cookies — no Chrome. Only when the
  // caller can't need browser-only features (screenshot / cookie harvest).
  const fastEligible =
    fastPath &&
    !screenshot &&
    returnType !== 'cookies' &&
    Array.isArray(cookies) &&
    cookies.length > 0;

  if (fastEligible) {
    const fast = await fetchFastPath(url, { cookies, userAgent, headers, timeout });
    if (fast) {
      metrics.incFastPath('scrape', 'hit');
      if (returnType === 'json') {
        try {
          return { url: fast.url, via: 'fetch', json: JSON.parse(fast.html) };
        } catch {
          return { url: fast.url, via: 'fetch', html: fast.html };
        }
      }
      if (returnType === 'html') {
        return { url: fast.url, via: 'fetch', html: fast.html };
      }
      return { url: fast.url, via: 'fetch', status: fast.status, cookies, html: fast.html };
    }
    metrics.incFastPath('scrape', 'miss');
  }

  // Browser path via the pool.
  const slot = await pool.acquire();
  const startTime = Date.now();
  try {
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // Recreate the browser if it has crashed or is dead before navigating
      if (!slot.browser || !slot.browser.connected || !slot.page || slot.page.isClosed()) {
        console.log(`flareburner: Browser slot is dead. Recreating browser (attempt ${attempt}/2)…`);
        await pool.recreate(slot);
      }

      try {
        await navigate(slot.page, url, {
          cookies,
          userAgent,
          headers,
          waitUntil,
          timeout,
          waitForSelector,
          blockResources,
        });
        const result = await buildResult(slot.page, { returnType, screenshot });
        // Harvest clearance so the binary fast-path can reuse it.
        if (Array.isArray(result.cookies)) rememberClearance(result.url || url, result.cookies, result.userAgent);
        metrics.recordSolveTime((Date.now() - startTime) / 1000);
        await pool.release(slot);
        return result;
      } catch (err) {
        lastErr = err;
        const isDead = !slot.browser || !slot.browser.connected || !slot.page || slot.page.isClosed();
        if (!isDead && !isTransientNavError(err)) {
          throw err;
        }
      }
    }
    throw lastErr;
  } catch (err) {
    await pool.replace(slot); // recreate the (possibly broken) slot, then release
    throw err;
  }
}

/**
 * Fetches a (possibly Cloudflare-protected) binary resource — e.g. an image.
 *
 * Tries a plain fetch with the cached clearance for this origin first (no browser,
 * so many images resolve concurrently). Only when that's challenged does it lease
 * the warm browser to solve the origin, then reads the real bytes from the
 * navigation response and refreshes the cached clearance.
 *
 * @returns {Promise<{status:number,buffer:Buffer,contentType:string,via:string}>}
 */
async function fetchBinary(url, { timeout = config.navTimeout } = {}) {
  // 1) Fast-path: plain fetch from this host using cached clearance for this origin.
  const cached = getClearance(url);
  if (cached && cached.cookies) {
    const fast = await fetchBinaryFastPath(url, {
      cookies: cached.cookies,
      userAgent: cached.userAgent,
      timeout,
    });
    if (fast) {
      metrics.incFastPath('binary', 'hit');
      return fast;
    }
    metrics.incFastPath('binary', 'miss');
  }

  // 2) Browser path: navigate (solving any challenge), then read the bytes.
  const slot = await pool.acquire();
  try {
    if (!slot.browser || !slot.browser.connected || !slot.page || slot.page.isClosed()) {
      console.log('flareburner: Browser slot is dead. Recreating browser for binary fetch…');
      await pool.recreate(slot);
    }
    let resp = await slot.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const ct = resp ? resp.headers()['content-type'] || '' : '';
    const challenged = !resp || resp.status() === 403 || resp.status() === 503 || /text\/html/i.test(ct);
    if (challenged) {
      await waitForCloudflare(slot.page, timeout);
      // Re-request now that clearance is set, to capture the real image bytes.
      resp = await slot.page.goto(url, { waitUntil: 'networkidle2', timeout });
    }
    const buffer = await resp.buffer();
    const contentType = resp.headers()['content-type'] || 'application/octet-stream';
    rememberClearance(
      slot.page.url() || url,
      await slot.page.cookies(),
      await slot.page.evaluate(() => navigator.userAgent),
    );
    await pool.release(slot);
    return { status: resp.status(), buffer, contentType, via: 'browser' };
  } catch (err) {
    await pool.replace(slot);
    throw err;
  }
}

/**
 * General-purpose Cloudflare-solving proxy. Runs an arbitrary HTTP request
 * (method / headers / body / redirect mode) FROM this host using the harvested
 * clearance, so callers can drive multi-step flows — e.g. a kwik form POST that
 * 302s to the real media URL — without ever holding cf_clearance themselves
 * (it's bound to this host's IP + UA).
 *
 * Tries the plain-fetch fast-path with cached clearance for this origin first;
 * if Cloudflare challenges, it leases the warm browser to solve the request's
 * ORIGIN, harvests fresh clearance, then replays the real request via the fast-path.
 *
 * @returns {Promise<{url:string,status:number,headers:object,setCookie:string[],body:string,via:string}>}
 */
async function fetchProxy(url, opts = {}) {
  const { method = 'GET', headers, body, redirect = 'follow', timeout = config.navTimeout } = opts;

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const tryFast = (clearance) =>
    fetchProxyFastPath(url, {
      cookies: clearance.cookies,
      userAgent: clearance.userAgent,
      method,
      headers,
      body,
      redirect,
      timeout,
    });

  // 1) Fast-path with clearance cached for this origin.
  const cached = getClearance(url);
  if (cached && cached.cookies) {
    const fast = await tryFast(cached);
    if (fast) {
      metrics.incFastPath('proxy', 'hit');
      return fast;
    }
    metrics.incFastPath('proxy', 'miss');
  }

  // 2) Browser: solve Cloudflare for this origin, harvest clearance, then replay.
  const slot = await pool.acquire();
  let clearance;
  try {
    if (!slot.browser || !slot.browser.connected || !slot.page || slot.page.isClosed()) {
      console.log('flareburner: Browser slot is dead. Recreating browser for proxy origin solving…');
      await pool.recreate(slot);
    }
    await slot.page.goto(origin, { waitUntil: 'domcontentloaded', timeout });
    await waitForCloudflare(slot.page, timeout);
    clearance = {
      cookies: await slot.page.cookies(),
      userAgent: await slot.page.evaluate(() => navigator.userAgent),
    };
    rememberClearance(origin, clearance.cookies, clearance.userAgent);
    await pool.release(slot);
  } catch (err) {
    await pool.replace(slot);
    throw err;
  }

  const fast = await tryFast(clearance);
  if (fast) return fast;
  throw new Error('fetch challenged even after solving Cloudflare');
}

// ---------------------------------------------------------------------------
// FlareSolverr v1 API Handler
// ---------------------------------------------------------------------------
async function handleFlareSolverr(req, res, body) {
  const startTimestamp = Date.now();
  const cmd = String(body.cmd || '');

  const makeEnvelope = (status, message, extra = {}) => ({
    status,
    message,
    startTimestamp,
    endTimestamp: Date.now(),
    version: 'v1.0.0',
    ...extra,
  });

  switch (cmd) {
    case 'sessions.create': {
      try {
        const session = await sessionManager.create(body.session, { proxy: body.proxy });
        metrics.incFs(cmd, 'ok');
        metrics.incHttp('/v1', 'POST', 200);
        return sendJson(res, 200, makeEnvelope('ok', 'Session created successfully.', {
          session: session.id,
        }));
      } catch (err) {
        metrics.incFs(cmd, 'error');
        metrics.incHttp('/v1', 'POST', 500);
        return sendJson(res, 500, makeEnvelope('error', err.message || String(err)));
      }
    }

    case 'sessions.list': {
      metrics.incFs(cmd, 'ok');
      metrics.incHttp('/v1', 'POST', 200);
      return sendJson(res, 200, makeEnvelope('ok', '', {
        sessions: sessionManager.list(),
      }));
    }

    case 'sessions.destroy': {
      if (!body.session) {
        metrics.incFs(cmd, 'error');
        metrics.incHttp('/v1', 'POST', 400);
        return sendJson(res, 400, makeEnvelope('error', 'The parameter "session" is required.'));
      }
      const destroyed = await sessionManager.destroy(body.session);
      if (!destroyed) {
        metrics.incFs(cmd, 'error');
        metrics.incHttp('/v1', 'POST', 500);
        return sendJson(res, 500, makeEnvelope('error', 'This session does not exist.'));
      }
      metrics.incFs(cmd, 'ok');
      metrics.incHttp('/v1', 'POST', 200);
      return sendJson(res, 200, makeEnvelope('ok', 'The session has been removed.'));
    }

    case 'request.get':
    case 'request.post': {
      if (!body.url) {
        metrics.incFs(cmd, 'error');
        metrics.incHttp('/v1', 'POST', 400);
        return sendJson(res, 400, makeEnvelope('error', 'The parameter "url" is required.'));
      }
      if (!isValidHttpUrl(body.url)) {
        metrics.incFs(cmd, 'error');
        metrics.incHttp('/v1', 'POST', 400);
        return sendJson(res, 400, makeEnvelope('error', 'Invalid URL. Must be a valid HTTP or HTTPS URL.'));
      }

      const timeout = num(body.maxTimeout, config.navTimeout);
      const isPost = cmd === 'request.post';
      const solveStart = Date.now();
      const blockResources = body.blockResources !== undefined ? body.blockResources : config.blockResources;

      try {
        let solution;
        if (body.session) {
          const session = sessionManager.get(body.session);
          if (!session) {
            metrics.incFs(cmd, 'error');
            metrics.incHttp('/v1', 'POST', 500);
            return sendJson(res, 500, makeEnvelope('error', 'This session does not exist.'));
          }

          await navigate(session.page, body.url, {
            cookies: body.cookies,
            headers: body.headers,
            userAgent: body.userAgent,
            timeout,
            method: isPost ? 'POST' : 'GET',
            postData: body.postData,
            blockResources,
          });

          const pageUrl = session.page.url() || body.url;
          const cookies = await session.page.cookies();
          const userAgent = await session.page.evaluate(() => navigator.userAgent);
          const responseHtml = body.returnOnlyCookies ? '' : await session.page.content();

          solution = {
            url: pageUrl,
            status: 200,
            headers: {},
            response: responseHtml,
            cookies,
            userAgent,
          };
          if (cookies && cookies.length) {
            rememberClearance(pageUrl, cookies, userAgent);
          }
        } else {
          // No session: lease from pool or use one-off if custom proxy requested
          let slot;
          let browserToClose = null;
          let pageToUse;

          if (body.proxy) {
            const oneOff = await connectBrowser({ headless: config.headless, proxy: body.proxy });
            browserToClose = oneOff.browser;
            pageToUse = oneOff.page;
          } else {
            slot = await pool.acquire();
            if (!slot.browser || !slot.browser.connected || !slot.page || slot.page.isClosed()) {
              await pool.recreate(slot);
            }
            pageToUse = slot.page;
          }

          try {
            await navigate(pageToUse, body.url, {
              cookies: body.cookies,
              headers: body.headers,
              userAgent: body.userAgent,
              timeout,
              method: isPost ? 'POST' : 'GET',
              postData: body.postData,
              blockResources,
            });

            const pageUrl = pageToUse.url() || body.url;
            const cookies = await pageToUse.cookies();
            const userAgent = await pageToUse.evaluate(() => navigator.userAgent);
            const responseHtml = body.returnOnlyCookies ? '' : await pageToUse.content();

            solution = {
              url: pageUrl,
              status: 200,
              headers: {},
              response: responseHtml,
              cookies,
              userAgent,
            };
            if (cookies && cookies.length) {
              rememberClearance(pageUrl, cookies, userAgent);
            }
          } finally {
            if (slot) {
              await pool.release(slot);
            }
            if (browserToClose) {
              browserToClose.close().catch(() => {});
            }
          }
        }

        const durationSec = (Date.now() - solveStart) / 1000;
        metrics.recordSolveTime(durationSec);
        metrics.incFs(cmd, 'ok');
        metrics.incHttp('/v1', 'POST', 200);

        return sendJson(res, 200, makeEnvelope('ok', 'Challenge solved!', { solution }));
      } catch (err) {
        metrics.incFs(cmd, 'error');
        metrics.incHttp('/v1', 'POST', 500);
        return sendJson(res, 500, makeEnvelope('error', `Error: ${err.message || String(err)}`));
      }
    }

    default: {
      metrics.incFs(cmd, 'error');
      metrics.incHttp('/v1', 'POST', 400);
      return sendJson(res, 400, makeEnvelope('error', `The command '${cmd}' is not implemented.`));
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/health' && req.method === 'GET') {
    metrics.incHttp('/health', 'GET', 200);
    return sendJson(res, 200, {
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      pool: pool.stats(),
      sessions: {
        active: sessionManager.list().length,
        list: sessionManager.details(),
      },
      proxy: config.proxyUrl ? 'configured' : 'none',
      clearanceCache: { size: clearanceCache.size },
      metrics: metrics.summary(),
    });
  }

  if (pathname === '/metrics' && req.method === 'GET') {
    metrics.incHttp('/metrics', 'GET', 200);
    const promText = metrics.toPrometheusText({
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      poolStats: pool.stats(),
      activeSessions: sessionManager.list().length,
      clearanceCacheSize: clearanceCache.size,
    });
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(promText),
    });
    return res.end(promText);
  }

  if (pathname === '/' && req.method === 'GET') {
    metrics.incHttp('/', 'GET', 200);
    return sendJson(res, 200, {
      service: 'flareburner',
      endpoints: {
        'GET /health': 'liveness, pool stats, sessions, proxy, clearance cache & metrics summary',
        'GET /metrics': 'Prometheus exposition text metrics',
        'POST /v1': 'FlareSolverr v1 drop-in API (cmd: request.get, request.post, sessions.create, sessions.list, sessions.destroy) OR native flareburner scrape',
        'POST /binary': 'fetch a Cloudflare-protected binary (e.g. image) and return the raw bytes; body: { url, timeout? }',
        'POST /fetch': 'general Cloudflare-solving proxy; runs an arbitrary request from this host and returns { status, headers, setCookie, body }; body: { url, method?, headers?, body?, redirect?, timeout? }',
      },
      body: {
        url: 'string (required) — target HTTP/HTTPS URL',
        cookies: 'array (optional) — reuse a prior cookies set; enables the no-Chrome fast-path',
        userAgent: 'string (optional)',
        headers: 'object (optional) — extra HTTP headers',
        returnType: "'full' | 'html' | 'cookies' | 'json' (default 'full')",
        screenshot: 'boolean (optional) — include base64 PNG',
        waitUntil: "puppeteer waitUntil (default 'domcontentloaded')",
        waitForSelector: 'string (optional) — wait for this selector',
        blockResources: 'boolean (optional) — block images, fonts, media for faster solve times',
        timeout: `ms (default ${config.navTimeout})`,
        fastPath: 'boolean (default true) — set false to force the browser',
      },
      flaresolverr: {
        compatible: true,
        commands: ['sessions.create', 'sessions.list', 'sessions.destroy', 'request.get', 'request.post'],
      },
      auth: config.apiKey ? 'send X-API-Key or Authorization: Bearer <key>' : 'none',
    });
  }

  if (pathname === '/v1') {
    if (req.method !== 'POST') {
      metrics.incHttp('/v1', req.method, 405);
      return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
    }
    if (!authorized(req)) {
      metrics.incHttp('/v1', req.method, 401);
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    const body = await parseJsonBody(req, res);
    if (body === null) return;

    // FlareSolverr v1 drop-in command support
    if (body.cmd) {
      return handleFlareSolverr(req, res, body);
    }

    // Native flareburner scrape
    const rawUrl =
      typeof body.url === 'string' && body.url.trim() ? body.url.trim() : config.defaultUrl;

    if (!rawUrl) {
      metrics.incHttp('/v1', 'POST', 400);
      return sendJson(res, 400, { error: 'url is required' });
    }
    if (!isValidHttpUrl(rawUrl)) {
      metrics.incHttp('/v1', 'POST', 400);
      return sendJson(res, 400, { error: 'Invalid URL. Must be a valid HTTP or HTTPS URL.' });
    }

    try {
      const result = await scrape({ ...body, url: rawUrl });
      metrics.incHttp('/v1', 'POST', 200);
      return sendJson(res, 200, result);
    } catch (err) {
      metrics.incHttp('/v1', 'POST', 500);
      return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  }

  if (pathname === '/binary') {
    if (req.method !== 'POST') {
      metrics.incHttp('/binary', req.method, 405);
      return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
    }
    if (!authorized(req)) {
      metrics.incHttp('/binary', req.method, 401);
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    const body = await parseJsonBody(req, res);
    if (body === null) return;

    if (typeof body.url !== 'string' || !body.url.trim()) {
      metrics.incHttp('/binary', 'POST', 400);
      return sendJson(res, 400, { error: 'url is required' });
    }
    if (!isValidHttpUrl(body.url)) {
      metrics.incHttp('/binary', 'POST', 400);
      return sendJson(res, 400, { error: 'Invalid URL. Must be a valid HTTP or HTTPS URL.' });
    }

    try {
      const { status, buffer, contentType } = await fetchBinary(body.url.trim(), {
        timeout: body.timeout,
      });
      metrics.incHttp('/binary', 'POST', status >= 200 && status < 300 ? 200 : status);
      return sendBinary(res, status >= 200 && status < 300 ? 200 : status, buffer, contentType);
    } catch (err) {
      metrics.incHttp('/binary', 'POST', 502);
      return sendJson(res, 502, { error: String(err && err.message ? err.message : err) });
    }
  }

  if (pathname === '/fetch') {
    if (req.method !== 'POST') {
      metrics.incHttp('/fetch', req.method, 405);
      return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
    }
    if (!authorized(req)) {
      metrics.incHttp('/fetch', req.method, 401);
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    const body = await parseJsonBody(req, res);
    if (body === null) return;

    if (typeof body.url !== 'string' || !body.url.trim()) {
      metrics.incHttp('/fetch', 'POST', 400);
      return sendJson(res, 400, { error: 'url is required' });
    }
    if (!isValidHttpUrl(body.url)) {
      metrics.incHttp('/fetch', 'POST', 400);
      return sendJson(res, 400, { error: 'Invalid URL. Must be a valid HTTP or HTTPS URL.' });
    }

    try {
      const result = await fetchProxy(body.url.trim(), {
        method: body.method,
        headers: body.headers,
        body: body.body,
        redirect: body.redirect,
        timeout: body.timeout,
      });
      metrics.incHttp('/fetch', 'POST', 200);
      return sendJson(res, 200, result);
    } catch (err) {
      metrics.incHttp('/fetch', 'POST', 502);
      return sendJson(res, 502, { error: String(err && err.message ? err.message : err) });
    }
  }

  metrics.incHttp(pathname, req.method, 404);
  return sendJson(res, 404, { error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
(async () => {
  console.log(`flareburner: warming ${config.poolSize} browser(s) (headless=${config.headless})…`);
  if (config.proxyUrl) {
    console.log(`flareburner: upstream proxy configured: ${config.proxyUrl.replace(/:[^:@]+@/, ':****@')}`);
  }
  await pool.init();
  server.listen(config.port, () => {
    console.log(`flareburner API listening on http://0.0.0.0:${config.port}`);
    console.log(`  GET  /health   (liveness + pool + session stats)`);
    console.log(`  GET  /metrics  (Prometheus metrics exposition)`);
    console.log(`  POST /v1       ${config.apiKey ? '(API key required)' : '(open)'} (FlareSolverr v1 & native scraping)`);
    console.log(`  POST /binary   (fetch protected image bytes)`);
    console.log(`  POST /fetch    (general Cloudflare-solving proxy)`);
    console.log(
      `Try: curl -X POST http://localhost:${config.port}/v1 -H "Content-Type: application/json" -d '{"url":"${config.defaultUrl}"}'`,
    );
  });
})().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

// Graceful shutdown so Chrome processes don't linger.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} — shutting down…`);
    server.close();
    await Promise.all([
      pool.close(),
      sessionManager.close(),
    ]);
    process.exit(0);
  });
}
