// Сервер синхронизации планера (Cloudflare Worker + KV).
//
// Сервер хранит по одному зашифрованному блоку на аккаунт и ничего не может прочитать:
// приложение шифрует данные на устройстве (AES-256-GCM), а сюда присылает только шифр
// и пропуск, выведенный из ключа. Сам ключ и ключ шифрования сервер никогда не видит.
//
// Настройки воркера (Settings → Variables and Secrets / Bindings):
//   DATA             — привязка к KV-хранилищу (KV namespace binding)
//   ACCOUNTS         — секрет: отпечатки пропусков разрешённых аккаунтов через запятую
//   ALLOWED_ORIGINS  — адреса сайта планера через запятую, например https://aronlucky.github.io
//   VAPID_PRIVATE_JWK — секрет: ключ подписи push-уведомлений (JSON), выдаёт Claude
//   Cron Trigger «* * * * *» — раз в минуту рассылает наступившие напоминания
//
// Напоминания: устройство сообщает только моменты времени (без названий дел) и адрес
// push-канала своего браузера. В нужную минуту сервер шлёт пустой push-сигнал, а текст
// уведомления устройство берёт из своей памяти.

const MAX_BODY = 2 * 1024 * 1024;   // 2 МБ шифра — это десятки тысяч дел
const PUSH_KEY = 'push:all';
const MAX_DEVICES = 50;
const MAX_TIMES = 500;
// push можно отправлять только в настоящие push-службы браузеров
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const te = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function reply(body, status, cors) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...cors
    }
  });
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = origin && allowed.includes(origin) ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    } : {};
    if (req.method === 'OPTIONS') return reply(null, cors['Access-Control-Allow-Origin'] ? 204 : 403, cors);

    const path = new URL(req.url).pathname;
    if (path !== '/v1/data' && path !== '/v1/push') return reply({ error: 'not_found' }, 404, cors);

    // пропуск — 64 hex-символа; храним и сравниваем только его SHA-256
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('Authorization') || '');
    const accounts = new Set((env.ACCOUNTS || '').toLowerCase().split(/[\s,]+/).filter(Boolean));
    const id = m ? await sha256hex(m[1]) : '';
    if (!id || !accounts.has(id)) return reply({ error: 'unauthorized' }, 401, cors);

    if (path === '/v1/push') {
      if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, cors);
      return registerPush(req, env, id, cors);
    }

    const kvKey = 'acc:' + id;
    const current = (await env.DATA.get(kvKey, 'json')) || { rev: 0, data: null };

    if (req.method === 'GET') return reply({ rev: current.rev, data: current.data }, 200, cors);

    if (req.method === 'PUT') {
      if (+(req.headers.get('Content-Length') || 0) > MAX_BODY) return reply({ error: 'too_large' }, 413, cors);
      const text = await req.text();
      if (text.length > MAX_BODY) return reply({ error: 'too_large' }, 413, cors);
      let body;
      try { body = JSON.parse(text); } catch { return reply({ error: 'bad_json' }, 400, cors); }
      if (!body || !Number.isInteger(body.baseRev) || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(body.data)) {
        return reply({ error: 'bad_request' }, 400, cors);
      }
      // кто-то успел записать раньше — отдаём свежую версию, приложение сольёт и повторит
      if (body.baseRev !== current.rev) return reply({ rev: current.rev, data: current.data }, 409, cors);
      const next = { rev: current.rev + 1, data: body.data, updated: Date.now() };
      await env.DATA.put(kvKey, JSON.stringify(next));
      return reply({ rev: next.rev }, 200, cors);
    }

    return reply({ error: 'method_not_allowed' }, 405, cors);
  },

  // Cron Trigger: раз в минуту
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDuePushes(env));
  }
};

// { endpoint, times: [ms, …] } — заменить расписание этого устройства (пустой список — удалить)
async function registerPush(req, env, accountId, cors) {
  const text = await req.text();
  if (text.length > 64 * 1024) return reply({ error: 'too_large' }, 413, cors);
  let body;
  try { body = JSON.parse(text); } catch { return reply({ error: 'bad_json' }, 400, cors); }
  let host = '';
  try { const u = new URL(body.endpoint); if (u.protocol === 'https:') host = u.hostname; } catch { /* invalid */ }
  const now = Date.now();
  if (!host || body.endpoint.length > 1000 || !PUSH_HOSTS.some(h => host === h || host.endsWith('.' + h)) ||
      !Array.isArray(body.times) || body.times.length > MAX_TIMES ||
      !body.times.every(t => Number.isInteger(t) && t > now - 3600e3 && t < now + 400 * 864e5)) {
    return reply({ error: 'bad_request' }, 400, cors);
  }
  const all = (await env.DATA.get(PUSH_KEY, 'json')) || {};
  const key = await sha256hex(body.endpoint);
  if (!body.times.length) delete all[key];
  else all[key] = { endpoint: body.endpoint, times: [...new Set(body.times)].sort((a, b) => a - b), acc: accountId, upd: now };
  const keys = Object.keys(all).sort((a, b) => all[b].upd - all[a].upd);
  for (const k of keys.slice(MAX_DEVICES)) delete all[k];
  await env.DATA.put(PUSH_KEY, JSON.stringify(all));
  return reply({ ok: true }, 200, cors);
}

async function sendDuePushes(env) {
  const all = await env.DATA.get(PUSH_KEY, 'json');
  if (!all || !env.VAPID_PRIVATE_JWK) return;
  const now = Date.now();
  let changed = false;
  for (const [key, dev] of Object.entries(all)) {
    const due = dev.times.filter(t => t <= now + 30e3);
    if (!due.length) continue;
    dev.times = dev.times.filter(t => t > now + 30e3);
    changed = true;
    if (!due.some(t => t > now - 15 * 60e3)) continue;     // давно прошедшие — не будим
    const status = await sendPush(env, dev.endpoint);
    if (status === 404 || status === 410) delete all[key];  // подписка больше не действует
  }
  for (const [key, dev] of Object.entries(all)) if (!dev.times.length) delete all[key];
  if (changed) await env.DATA.put(PUSH_KEY, JSON.stringify(all));
}

// пустой push по стандарту Web Push с подписью VAPID (ES256)
async function sendPush(env, endpoint) {
  try {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const part = o => b64url(te.encode(JSON.stringify(o)));
    const unsigned = part({ typ: 'JWT', alg: 'ES256' }) + '.' +
      part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://aronlucky.github.io' });
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned));
    const pub = new Uint8Array(65);
    pub[0] = 4;
    pub.set(fromB64url(jwk.x), 1);
    pub.set(fromB64url(jwk.y), 33);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `vapid t=${unsigned}.${b64url(sig)}, k=${b64url(pub)}`, TTL: '900', Urgency: 'high', 'Content-Length': '0' }
    });
    return res.status;
  } catch {
    return 0;
  }
}
