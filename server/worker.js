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

const MAX_BODY = 2 * 1024 * 1024;   // 2 МБ шифра — это десятки тысяч дел

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
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    } : {};
    if (req.method === 'OPTIONS') return reply(null, cors['Access-Control-Allow-Origin'] ? 204 : 403, cors);

    if (new URL(req.url).pathname !== '/v1/data') return reply({ error: 'not_found' }, 404, cors);

    // пропуск — 64 hex-символа; храним и сравниваем только его SHA-256
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('Authorization') || '');
    const accounts = new Set((env.ACCOUNTS || '').toLowerCase().split(/[\s,]+/).filter(Boolean));
    const id = m ? await sha256hex(m[1]) : '';
    if (!id || !accounts.has(id)) return reply({ error: 'unauthorized' }, 401, cors);

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
  }
};
