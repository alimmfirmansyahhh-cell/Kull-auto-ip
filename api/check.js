import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'node:https';

const TARGET = 'https://ipinfo.io/json';
const TIMEOUT_MS = 12000;

function proxyRequest(proxyUrl, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let agent;
    try {
      agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs });
    } catch (e) {
      return resolve({ ok: false, latencyMs: 0, error: 'Bad proxy url' });
    }

    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve({ latencyMs: Date.now() - start, ...r });
    };

    const req = https.request(TARGET, {
      method: 'GET',
      agent,
      timeout: timeoutMs,
      headers: { 'User-Agent': 'LIMZXCM/1.0', 'Accept': 'application/json' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 100000) req.destroy(); });
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        if (res.statusCode < 200 || res.statusCode >= 400) {
          return finish({ ok: false, latencyMs, error: 'HTTP ' + res.statusCode });
        }
        try {
          const data = JSON.parse(body);
          if (!data || !data.ip) return finish({ ok: false, latencyMs, error: 'No IP' });
          finish({
            ok: true, latencyMs,
            exitIp: data.ip,
            geo: {
              country: data.country || '',
              region: data.region || '',
              city: data.city || '',
              zip: data.postal || '',
              org: data.org || ''
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const { host, port, pass, variants, retries = 1 } = body;

  if (!host || !port || !pass || !Array.isArray(variants) || !variants.length) {
    return res.status(400).json({ error: 'Missing: host, port, pass, variants' });
  }

  const nRetry = Math.max(1, Math.min(3, parseInt(retries) || 1));
  const list = variants.slice(0, 8);

  const results = [];
  for (const v of list) {
    if (!v || !v.username || typeof v.username !== 'string') continue;

    const attempts = [];
    for (let i = 0; i < nRetry; i++) {
      const proxyUrl = `http://${encodeURIComponent(v.username)}:${encodeURIComponent(pass)}@${host}:${port}`;
      attempts.push(await proxyRequest(proxyUrl, TIMEOUT_MS));
    }

    const oks = attempts.filter(a => a.ok);
    const successRate = Math.round((oks.length / attempts.length) * 100);
    const avgLatency = Math.round(attempts.reduce((s, a) => s + (a.latencyMs || 0), 0) / attempts.length);

    results.push({
      name: v.name || v.username,
      username: v.username,
      attempts,
      successRate,
      avgLatency,
      okCount: oks.length,
      total: attempts.length,
      best: oks[0] || null
    });
  }

  results.sort((a, b) =>
    b.successRate !== a.successRate ? b.successRate - a.successRate : a.avgLatency - b.avgLatency
  );

  return res.status(200).json({ ok: true, ts: Date.now(), results });
}

export const config = { maxDuration: 60 };
