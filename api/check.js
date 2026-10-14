import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'node:https';

const TARGET = 'https://ipinfo.io/json';
const TIMEOUT_MS = 15000;

function proxyRequest(proxyUrl, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let agent;
    try { agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs }); }
    catch (e) { return resolve({ ok: false, latencyMs: 0, error: 'Bad proxy url' }); }

    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve({ latencyMs: Date.now() - start, ...r }); };

    const req = https.request(TARGET, {
      method: 'GET', agent, timeout: timeoutMs,
      headers: { 'User-Agent': 'LIMZXCM/1.0', 'Accept': 'application/json' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 100000) req.destroy(); });
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        if (res.statusCode < 200 || res.statusCode >= 400) {
          return finish({ ok: false, latencyMs, error: 'Gateway HTTP ' + res.statusCode });
        }
        try {
          const data = JSON.parse(body);
          if (!data || !data.ip) return finish({ ok: false, latencyMs, error: 'No IP in response' });
          const asnMatch = (data.org || '').match(/^AS(\d+)/);
          finish({
            ok: true, latencyMs,
            exitIp: data.ip,
            geo: {
              country: (data.country || '').toLowerCase(),
              region: data.region || '',
              city: data.city || '',
              zip: data.postal || '',
              org: data.org || '',
              asn: asnMatch ? asnMatch[1] : ''
            }
          });
        } catch { finish({ ok: false, latencyMs, error: 'Bad JSON' }); }
      });
    });

    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (e) => finish({ ok: false, error: e.message || 'Failed' }));
    req.end();
  });
}

const slug = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');

/* Skor match: negara 30 + prov 20 + kota 20 + zip 15 + asn 15 = 100 */
function scoreMatch(target, exit) {
  if (!exit || !exit.geo) return { score: 0, breakdown: {} };
  let score = 0;
  const b = { country: 0, region: 0, city: 0, zip: 0, asn: 0 };
  if (target.country && exit.geo.country && slug(target.country) === slug(exit.geo.country)) { score += 30; b.country = 30; }
  if (target.region && exit.geo.region && slug(target.region) === slug(exit.geo.region))     { score += 20; b.region = 20; }
  if (target.city && exit.geo.city && slug(target.city) === slug(exit.geo.city))             { score += 20; b.city = 20; }
  if (target.zip && exit.geo.zip && slug(target.zip) === slug(exit.geo.zip))                 { score += 15; b.zip = 15; }
  if (target.asn && exit.geo.asn && String(target.asn) === String(exit.geo.asn))             { score += 15; b.asn = 15; }
  return { score, breakdown: b };
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

  const { host, port, pass, variants, retries = 1, waterfall = true, minScore = 80 } = body;

  if (!host || !port || !pass || !Array.isArray(variants) || !variants.length) {
    return res.status(400).json({ error: 'Missing: host, port, pass, variants' });
  }

  const nRetry = Math.max(1, Math.min(3, parseInt(retries) || 1));
  const list = variants.slice(0, 8);
  const results = [];
  let stoppedEarly = false;

  for (const v of list) {
    if (!v || !v.username || typeof v.username !== 'string') continue;

    const attempts = [];
    let lastOk = null;

    for (let i = 0; i < nRetry; i++) {
      const proxyUrl = `http://${encodeURIComponent(v.username)}:${encodeURIComponent(pass)}@${host}:${port}`;
      const r = await proxyRequest(proxyUrl, TIMEOUT_MS);
      attempts.push(r);
      if (r.ok) { lastOk = r; break; } // stop retry begitu sukses
    }

    const oks = attempts.filter(a => a.ok);
    const successRate = Math.round((oks.length / attempts.length) * 100);
    const avgLatency = Math.round(attempts.reduce((s, a) => s + (a.latencyMs || 0), 0) / attempts.length);
    const match = lastOk ? scoreMatch(v.target || {}, lastOk) : { score: 0, breakdown: {} };

    results.push({
      id: v.id, name: v.name, username: v.username,
      target: v.target || null,
      attempts, successRate, avgLatency,
      okCount: oks.length, total: attempts.length,
      best: lastOk,
      matchScore: match.score,
      matchBreakdown: match.breakdown
    });

    // WATERFALL: stop kalau match score sudah bagus
    if (waterfall && match.score >= minScore) { stoppedEarly = true; break; }
  }

  return res.status(200).json({
    ok: true, ts: Date.now(), results, stoppedEarly,
    tested: results.length, total: list.length
  });
}

export const config = { maxDuration: 60 };
