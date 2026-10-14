import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'node:https';

const TIMEOUT_MS = 20000;
const GAP_BETWEEN_VARIANTS_MS = 700;
const RETRY_DELAY_MS = 1500;

// Target untuk uji lewat proxy — coba ipapi.co dulu, fallback ipinfo.io
const TARGETS = [
  { url: 'https://ipapi.co/json/',  parse: parseIpapi },
  { url: 'https://ipinfo.io/json',  parse: parseIpinfo }
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Parsing response dari ipapi.co */
function parseIpapi(data) {
  if (!data || !data.ip || data.error) return null;
  return {
    ip: data.ip,
    country: (data.country_code || '').toLowerCase(),
    countryName: data.country_name || '',
    region: data.region || '',
    city: data.city || '',
    zip: data.postal || '',
    asn: String(data.asn || '').replace(/^AS/i, ''),
    org: data.org || '',
    isp: data.org || '',
    source: 'ipapi.co'
  };
}

/* Parsing response dari ipinfo.io */
function parseIpinfo(data) {
  if (!data || !data.ip) return null;
  const asnMatch = (data.org || '').match(/^AS(\d+)/);
  return {
    ip: data.ip,
    country: (data.country || '').toLowerCase(),
    countryName: data.country || '',
    region: data.region || '',
    city: data.city || '',
    zip: data.postal || '',
    asn: asnMatch ? asnMatch[1] : '',
    org: data.org || '',
    isp: data.org || '',
    source: 'ipinfo.io'
  };
}

/* Coba satu target lewat proxy */
function tryTargetThroughProxy(target, proxyUrl, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let agent;
    try { agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs }); }
    catch (e) { return resolve({ ok: false, latencyMs: 0, error: 'Bad proxy url', retryable: false }); }

    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve({ latencyMs: Date.now() - start, ...r }); };

    const req = https.request(target.url, {
      method: 'GET', agent, timeout: timeoutMs,
      headers: { 'User-Agent': 'LIMZXCM/1.0', 'Accept': 'application/json' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 100000) req.destroy(); });
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        if (res.statusCode < 200 || res.statusCode >= 400) {
          return finish({
            ok: false, latencyMs,
            error: 'Gateway HTTP ' + res.statusCode,
            statusCode: res.statusCode,
            retryable: res.statusCode >= 500 || res.statusCode === 429,
            tryNext: res.statusCode === 429 || res.statusCode === 403
          });
        }
        try {
          const raw = JSON.parse(body);
          const parsed = target.parse(raw);
          if (!parsed) {
            return finish({ ok: false, latencyMs, error: 'Empty/invalid data', retryable: false, tryNext: true });
          }
          finish({
            ok: true, latencyMs,
            exitIp: parsed.ip,
            geo: {
              country: parsed.country,
              region: parsed.region,
              city: parsed.city,
              zip: parsed.zip,
              org: parsed.org,
              asn: parsed.asn
            },
            source: parsed.source
          });
        } catch { finish({ ok: false, latencyMs, error: 'Bad JSON', retryable: false, tryNext: true }); }
      });
    });

    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (e) => finish({ ok: false, error: e.message || 'Failed', retryable: true }));
    req.end();
  });
}

/* Proxy request — coba ipapi.co dulu, kalau gagal/rate-limit fallback ipinfo.io */
async function proxyRequest(proxyUrl, timeoutMs) {
  let lastErr = null;
  for (const target of TARGETS) {
    const r = await tryTargetThroughProxy(target, proxyUrl, timeoutMs);
    if (r.ok) return r;
    lastErr = r;
    // Kalau error-nya bukan "tryNext", langsung return (misal 503 retryable)
    if (!r.tryNext) return r;
    // Kalau 429/403 dari ipapi.co → coba ipinfo.io
  }
  return lastErr || { ok: false, error: 'All targets failed', retryable: true };
}

const slug = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');

function scoreMatch(target, exit) {
  if (!exit || !exit.geo) return { score: 0, breakdown: {} };
  let score = 0;
  const b = { country: 0, region: 0, city: 0, zip: 0, asn: 0 };
  if (target.country && exit.geo.country && slug(target.country) === slug(exit.geo.country)) { score += 30; b.country = 30; }
  if (target.region  && exit.geo.region  && slug(target.region)  === slug(exit.geo.region))  { score += 20; b.region  = 20; }
  if (target.city    && exit.geo.city    && slug(target.city)    === slug(exit.geo.city))    { score += 20; b.city    = 20; }
  if (target.zip     && exit.geo.zip     && slug(target.zip)     === slug(exit.geo.zip))     { score += 15; b.zip     = 15; }
  if (target.asn     && exit.geo.asn     && String(target.asn)   === String(exit.geo.asn))   { score += 15; b.asn     = 15; }
  return { score, breakdown: b };
}

async function testVariant(v, host, port, pass, maxRetries) {
  const attempts = [];
  let lastOk = null;

  for (let i = 0; i < maxRetries; i++) {
    const proxyUrl = `http://${encodeURIComponent(v.username)}:${encodeURIComponent(pass)}@${host}:${port}`;
    const r = await proxyRequest(proxyUrl, TIMEOUT_MS);
    attempts.push(r);

    if (r.ok) { lastOk = r; break; }
    if (!r.retryable) break;
    if (i < maxRetries - 1) await sleep(RETRY_DELAY_MS);
  }

  const oks = attempts.filter(a => a.ok);
  const successRate = Math.round((oks.length / attempts.length) * 100);
  const avgLatency = Math.round(attempts.reduce((s, a) => s + (a.latencyMs || 0), 0) / attempts.length);
  const match = lastOk ? scoreMatch(v.target || {}, lastOk) : { score: 0, breakdown: {} };

  return {
    id: v.id, name: v.name, username: v.username,
    target: v.target || null,
    attempts, successRate, avgLatency,
    okCount: oks.length, total: attempts.length,
    best: lastOk,
    matchScore: match.score,
    matchBreakdown: match.breakdown
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const {
    host, port, pass, variants,
    retries = 2,
    waterfall = true,
    minScore = 80,
    slowMode = true,
    fastMode = false
  } = body;

  if (!host || !port || !pass || !Array.isArray(variants) || !variants.length) {
    return res.status(400).json({ error: 'Missing: host, port, pass, variants' });
  }

  const nRetry = Math.max(1, Math.min(4, parseInt(retries) || 2));
  const list = variants.slice(0, 8);
  const results = [];
  let stoppedEarly = false;
  let winnerId = null;

  const toTest = fastMode ? list.slice(0, 1) : list;

  for (let i = 0; i < toTest.length; i++) {
    const v = toTest[i];
    if (!v || !v.username || typeof v.username !== 'string') continue;

    if (slowMode && i > 0) await sleep(GAP_BETWEEN_VARIANTS_MS);

    const r = await testVariant(v, host, port, pass, nRetry);
    results.push(r);

    if (r.okCount > 0 && r.matchScore >= minScore) {
      winnerId = r.id;
      if (waterfall) { stoppedEarly = true; break; }
    }
  }

  if (!winnerId && results.length) {
    const best = results.filter(r => r.okCount > 0).sort((a,b) => b.matchScore - a.matchScore)[0];
    if (best) winnerId = best.id;
  }

  return res.status(200).json({
    ok: true, ts: Date.now(),
    results, stoppedEarly, winnerId,
    tested: results.length, total: list.length, fastMode
  });
}

export const config = { maxDuration: 60 };
