/* =====================================================================
   Q-Terminal Cloudflare Worker
   1) 주식 시세 프록시        GET  /?url=<Yahoo Finance 주소>
   1-2) Yahoo 재무 데이터(인증 포함)   GET  /yf?path=<Yahoo 경로>   (종목정보 탭용)
   2) 로그인·동기화 API       /api/...   (D1 데이터베이스를 변수 이름 DB로 연결해야 함)
   ===================================================================== */
const PROXY_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com',
  // 코인 거래소 (브라우저에서 직접 연결이 막힐 때 경유)
  'api.upbit.com', 'data-api.binance.vision', 'api.binance.com', 'api1.binance.com', 'api3.binance.com',
  // 한국 주식 시간외(NXT·시간외 단일가) 시세: 네이버 증권
  'polling.finance.naver.com', 'm.stock.naver.com', 'api.stock.naver.com',
  // 종목정보 탭: 사업 설명 한국어 번역
  'translate.googleapis.com'];
const iterOf = env => Math.max(10000, Math.min(1000000, +env.PBKDF2_ITER || PBKDF2_ITER));   // 환경변수 PBKDF2_ITER로 조정 (유료 플랜이면 100000 이상 권장)
const PBKDF2_ITER = 30000;            // 무료 플랜 CPU 한도(요청당 10ms) 안에 들도록 조정한 값 (유료 플랜이면 100000 권장)
const SESSION_DAYS = 30;
const MAX_VALUE = 256 * 1024;         // 항목 하나 최대 256KB
const MAX_USER_BYTES = 5 * 1024 * 1024; // 회원 1명당 최대 5MB
const DAY = 86400000;

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runAlerts(env).catch(e => console.error('[alerts]', (e && e.message) || e))); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
    try {
      const gate = originGate(req, env, url); if (gate) return gate;
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (url.pathname === '/yf' || url.searchParams.has('url')) {
        await init(env);
        const me = await auth(req, env);
        if (!me) throw err(401, '관리자 승인을 받은 회원만 이용할 수 있습니다.');
        if (url.pathname === '/yf') return await yfProxy(req, env, url);
        return await proxy(req, env, url);
      }
      return new Response('Q-Terminal worker OK', { headers: { 'content-type': 'text/plain; charset=utf-8', ...cors(req, env) } });
    } catch (e) {
      return json(req, env, { error: e.status ? e.message : '서버 오류: ' + (e.message || e) }, e.status || 500);
    }
  }
};

/* ---------------- 공통 ---------------- */
// ALLOWED_ORIGINS(쉼표 구분)가 설정돼 있으면 루트(상태 확인)를 뺀 모든 경로에서 허용된 사이트의 요청만 받습니다.
// 프록시(/?url=, /yf)는 IP당 분당 호출 수도 제한합니다(인스턴스 단위 간이 제한).
const PROXY_RL = new Map(), PROXY_MAX_PER_MIN = 240;
function originGate(req, env, url) {
  if (url.pathname === '/' && !url.searchParams.has('url')) return null;
  const allow = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (allow.length) {
    const origin = req.headers.get('Origin');
    if (!origin || !allow.includes(origin)) return json(req, env, { error: '허용되지 않은 사이트에서의 요청입니다.' }, 403);
  }
  if (!url.pathname.startsWith('/api/')) {
    const ip = req.headers.get('cf-connecting-ip') || 'unknown', minute = Math.floor(Date.now() / 60000), cur = PROXY_RL.get(ip);
    if (!cur || cur.m !== minute) { if (PROXY_RL.size > 5000) PROXY_RL.clear(); PROXY_RL.set(ip, { m: minute, n: 1 }); }
    else if (++cur.n > PROXY_MAX_PER_MIN) return json(req, env, { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }, 429);
  }
  return null;
}
const err = (status, message) => Object.assign(new Error(message), { status });
function cors(req, env) {
  const origin = req.headers.get('Origin') || '*';
  const allow = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !allow.length || allow.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
const json = (req, env, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors(req, env) } });
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function pbkdf2(pw, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: iter }, key, 256));
}
async function makePw(pw, env) { const salt = randHex(16), it = iterOf(env); return { salt, hash: `pbkdf2$${it}$${await pbkdf2(pw, salt, it)}` }; }
async function checkPw(pw, u) { const [, it, h] = String(u.pw_hash).split('$'); return safeEq(await pbkdf2(pw, u.pw_salt, +it), h); }
const pub = u => ({ id: u.id, username: u.username, role: u.role, status: u.status });

/* ---------------- DB 스키마 (최초 요청 시 자동 생성) ---------------- */
let ready = false;
async function init(env) {
  if (ready) return;
  if (!env.DB) throw err(500, 'D1 데이터베이스가 연결되지 않았습니다. Worker → 설정 → 바인딩에서 변수 이름 DB로 D1을 연결하세요.');
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER, last_login INTEGER, fail_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER, expires_at INTEGER, ua TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_kv (user_id INTEGER NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, k))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_settings (k TEXT PRIMARY KEY, v TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rate_limit (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_tg (user_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL)`)
  ]);
  ready = true;
}
/* ---------------- 요청 제한 (D1) ---------------- */
const clientIP = req => req.headers.get('cf-connecting-ip') || 'unknown';
async function rlGet(env, k, now) { const r = await env.DB.prepare('SELECT n, reset FROM rate_limit WHERE k=?').bind(k).first(); return r && r.reset > now ? r.n : 0; }
async function rlHit(env, k, windowMs, now) {
  await env.DB.prepare('INSERT INTO rate_limit (k, n, reset) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset < ? THEN 1 ELSE n + 1 END, reset = CASE WHEN reset < ? THEN ? ELSE reset END')
    .bind(k, now + windowMs, now, now, now + windowMs).run();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM rate_limit WHERE reset < ?').bind(now).run();
}
async function rlClear(env, k) { await env.DB.prepare('DELETE FROM rate_limit WHERE k=?').bind(k).run(); }
async function getSetting(env, k, d) { const r = await env.DB.prepare('SELECT v FROM app_settings WHERE k=?').bind(k).first(); return r ? r.v : d; }

/* ---------------- 세션 ---------------- */
async function newSession(env, req, userId) {
  const token = randHex(32), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)')
      .bind(await sha256(token), userId, now, now + SESSION_DAYS * DAY, (req.headers.get('user-agent') || '').slice(0, 200))
  ]);
  return token;
}
async function auth(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!m) return null;
  const th = await sha256(m[1]), now = Date.now();
  const row = await env.DB.prepare('SELECT u.id, u.username, u.role, u.status, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(th).first();
  if (!row || row.expires_at < now || row.status !== 'active') return null;
  if (row.expires_at - now < 15 * DAY) await env.DB.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').bind(now + SESSION_DAYS * DAY, th).run();
  return { ...row, th };
}

/* ---------------- API ---------------- */
async function api(req, env, url) {
  const allow = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin');
  if (allow.length && origin && !allow.includes(origin)) throw err(403, '허용되지 않은 사이트에서의 요청입니다.');
  await init(env);
  const DB = env.DB, p = url.pathname, m = req.method, now = Date.now();
  const body = ['POST', 'PUT', 'PATCH'].includes(m) ? await req.json().catch(() => ({})) : {};
  const ok = obj => json(req, env, obj);

  if (p === '/api/status' && m === 'GET') {
    const c = await DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return ok({ ok: true, hasUsers: c.n > 0, signup: await getSetting(env, 'signup', 'approval'), needsSetupCode: c.n === 0 });
  }

  if (p === '/api/auth/signup' && m === 'POST') {
    const username = String(body.username || '').trim(), password = String(body.password || '');
    if (!/^[A-Za-z0-9_.\-가-힣]{3,30}$/.test(username)) throw err(400, '아이디는 3~30자의 영문·숫자·한글·_ . - 만 사용할 수 있습니다.');
    if (password.length < 8 || password.length > 128) throw err(400, '비밀번호는 8자 이상이어야 합니다.');
    const ip = clientIP(req);
    if (await rlGet(env, 'su:' + ip, now) >= 5) throw err(429, '가입 시도가 너무 많습니다. 1시간 뒤 다시 시도하세요.');
    await rlHit(env, 'su:' + ip, 3600000, now);
    const first = (await DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n === 0;
    if (first) {   // 배포 직후 아무나 관리자가 되지 못하도록 설정 코드(Worker 비밀 변수 ADMIN_SETUP_CODE)를 요구
      if (!env.ADMIN_SETUP_CODE) throw err(403, '최초 관리자 생성을 위해 Worker 변수에 ADMIN_SETUP_CODE(비밀 값)를 먼저 등록하세요.');
      if (!safeEq(String(body.setupCode || ''), String(env.ADMIN_SETUP_CODE))) throw err(403, '관리자 설정 코드가 올바르지 않습니다.');
    }
    const mode = first ? 'open' : await getSetting(env, 'signup', 'approval');
    if (mode === 'closed') throw err(403, '현재 회원가입이 닫혀 있습니다. 관리자에게 문의하세요.');
    if (await DB.prepare('SELECT id FROM users WHERE username=?').bind(username).first()) throw err(409, '이미 사용 중인 아이디입니다.');
    const { salt, hash } = await makePw(password, env);
    const role = first ? 'admin' : 'user', status = mode === 'open' ? 'active' : 'pending';
    const r = await DB.prepare('INSERT INTO users (username, pw_hash, pw_salt, role, status, created_at) VALUES (?,?,?,?,?,?)').bind(username, hash, salt, role, status, now).run();
    const id = r.meta.last_row_id;
    if (status !== 'active') return ok({ status, message: '가입 신청이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.' });
    await DB.prepare('UPDATE users SET last_login=? WHERE id=?').bind(now, id).run();
    return ok({ status, token: await newSession(env, req, id), user: { id, username, role, status } });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    const username = String(body.username || '').trim(), password = String(body.password || '');
    const ip = clientIP(req), uk = username.toLowerCase().slice(0, 40);
    // 실패 횟수를 (아이디+IP) 단위로 세어 공격자가 남의 계정을 잠가버릴 수 없게 하고, 분산 시도는 아이디 전체·IP 전체 한도로 막습니다.
    const kIp = `lf:${uk}|${ip}`, kUser = `lg:${uk}`, kAny = `la:${ip}`;
    if ((await rlGet(env, kIp, now)) >= 5 || (await rlGet(env, kUser, now)) >= 30 || (await rlGet(env, kAny, now)) >= 40)
      throw err(429, '로그인 시도가 너무 많습니다. 10분 뒤 다시 시도하세요.');
    const u = await DB.prepare('SELECT * FROM users WHERE username=?').bind(username).first();
    const fail = '아이디 또는 비밀번호가 올바르지 않습니다.';
    const bad = () => Promise.all([rlHit(env, kIp, 600000, now), rlHit(env, kUser, 600000, now), rlHit(env, kAny, 600000, now)]);
    if (!u) { await pbkdf2(password, 'aa'.repeat(16), iterOf(env)); await bad(); throw err(401, fail); }
    if (!(await checkPw(password, u))) {
      await bad();
      const left = Math.max(0, 5 - (await rlGet(env, kIp, now)));
      throw err(401, left ? `${fail} (남은 시도 ${left}회)` : '로그인 실패 5회로 10분간 제한됩니다.');
    }
    if (u.status === 'pending') throw err(403, '관리자 승인 대기 중입니다. 승인 후 로그인할 수 있습니다.');
    if (u.status === 'disabled') throw err(403, '사용이 중지된 계정입니다. 관리자에게 문의하세요.');
    await rlClear(env, kIp);
    if ((+String(u.pw_hash).split('$')[1] || 0) < iterOf(env)) {   // 반복 횟수를 올린 뒤 첫 로그인 때 해시를 새 강도로 교체
      const { salt, hash } = await makePw(password, env);
      await DB.prepare('UPDATE users SET pw_hash=?, pw_salt=? WHERE id=?').bind(hash, salt, u.id).run();
    }
    await DB.prepare('UPDATE users SET fail_count=0, locked_until=0, last_login=? WHERE id=?').bind(now, u.id).run();
    return ok({ token: await newSession(env, req, u.id), user: pub(u) });
  }

  // ----- 여기부터 로그인 필요 -----
  const me = await auth(req, env);
  if (!me) throw err(401, '로그인이 필요합니다.');

  if (p === '/api/auth/logout' && m === 'POST') { await DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(me.th).run(); return ok({ ok: true }); }
  if (p === '/api/me' && m === 'GET') return ok({ user: pub(me) });
  if (p === '/api/me/password' && m === 'POST') {
    const u = await DB.prepare('SELECT * FROM users WHERE id=?').bind(me.id).first();
    if (!(await checkPw(String(body.old || ''), u))) throw err(400, '현재 비밀번호가 올바르지 않습니다.');
    const np = String(body.password || ''); if (np.length < 8) throw err(400, '새 비밀번호는 8자 이상이어야 합니다.');
    const { salt, hash } = await makePw(np, env);
    await DB.batch([
      DB.prepare('UPDATE users SET pw_hash=?, pw_salt=? WHERE id=?').bind(hash, salt, me.id),
      DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(me.id, me.th)
    ]);
    return ok({ ok: true });
  }

  // 텔레그램 서버 알림 연결 (앱을 닫아도 1분마다 서버가 가격 알림을 확인)
  if (p === '/api/me/telegram') {
    if (m === 'GET') {
      const r = await DB.prepare('SELECT chat_id FROM user_tg WHERE user_id=?').bind(me.id).first();
      return ok({ chat: r ? r.chat_id : '', enabled: !!env.TELEGRAM_BOT_TOKEN, bot: env.TELEGRAM_BOT_NAME || '' });
    }
    if (m === 'PUT') {
      if (!env.TELEGRAM_BOT_TOKEN) throw err(400, '서버에 텔레그램 봇이 설정되지 않았습니다. (관리자: TELEGRAM_BOT_TOKEN)');
      const chat = String(body.chat || '').trim();
      if (!/^-?\d{5,20}$/.test(chat)) throw err(400, '채팅 ID는 숫자만 입력하세요.');
      if (await rlGet(env, 'tg:' + me.id, now) >= 5) throw err(429, '잠시 후 다시 시도하세요.');
      await rlHit(env, 'tg:' + me.id, 600000, now);
      if (!(await tgSend(env, chat, '✅ Q-Terminal 알림이 연결되었습니다. 가격 알림이 도달하면 이곳으로 알려드립니다.'))) throw err(400, '메시지를 보내지 못했습니다. 봇과 대화를 먼저 시작(/start)했는지, 채팅 ID가 맞는지 확인하세요.');
      await DB.prepare('INSERT INTO user_tg (user_id, chat_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id').bind(me.id, chat).run();
      return ok({ ok: true });
    }
    if (m === 'DELETE') { await DB.prepare('DELETE FROM user_tg WHERE user_id=?').bind(me.id).run(); return ok({ ok: true }); }
  }

  // 동기화 데이터 (즐겨찾기·작도)
  if (p === '/api/kv' && m === 'GET') {
    const since = Math.max(0, +url.searchParams.get('since') || 0), stamp = now - 2000;
    const r = await DB.prepare('SELECT k, v, updated_at FROM user_kv WHERE user_id=? AND updated_at>?').bind(me.id, since).all();
    return ok({ items: r.results, now: stamp });
  }
  if (p === '/api/kv/batch' && m === 'POST') {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return ok({ ok: true, now });
    if (items.length > 50) throw err(400, '한 번에 50개까지 저장할 수 있습니다.');
    let add = 0;
    for (const it of items) {
      if (typeof it.k !== 'string' || !/^[\w:.\-^=]{1,200}$/.test(it.k)) throw err(400, '잘못된 키: ' + String(it.k).slice(0, 40));
      if (typeof it.v !== 'string' || it.v.length > MAX_VALUE) throw err(413, '저장할 데이터가 너무 큽니다: ' + it.k);
      add += it.v.length;
    }
    const keys = items.map(it => it.k);
    const cur = await DB.prepare(`SELECT COALESCE(SUM(length(v)),0) AS total FROM user_kv WHERE user_id=? AND k NOT IN (${keys.map(() => '?').join(',')})`).bind(me.id, ...keys).first();
    if (cur.total + add > MAX_USER_BYTES) throw err(413, '저장 용량(5MB)을 초과했습니다. 오래된 작도를 정리하세요.');
    await DB.batch(items.map(it => DB.prepare('INSERT INTO user_kv (user_id, k, v, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id, k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind(me.id, it.k, it.v, now)));
    return ok({ ok: true, now });
  }

  // ----- 관리자 -----
  if (p.startsWith('/api/admin/')) {
    if (me.role !== 'admin') throw err(403, '관리자만 사용할 수 있습니다.');
    if (p === '/api/admin/stats' && m === 'GET') {
      const q = sql => DB.prepare(sql).first();
      const [u, s, kv] = await Promise.all([
        q(`SELECT COUNT(*) total, SUM(status='active') active, SUM(status='pending') pending, SUM(status='disabled') disabled, SUM(role='admin') admins FROM users`),
        DB.prepare('SELECT COUNT(*) n FROM sessions WHERE expires_at>?').bind(now).first(),
        q('SELECT COUNT(*) n, COALESCE(SUM(length(v)),0) bytes FROM user_kv')
      ]);
      return ok({ users: u, sessions: s.n, items: kv.n, bytes: kv.bytes });
    }
    if (p === '/api/admin/users' && m === 'GET') {
      const r = await DB.prepare(`SELECT u.id, u.username, u.role, u.status, u.created_at, u.last_login, u.locked_until,
          (SELECT COUNT(*) FROM user_kv WHERE user_id=u.id) items, (SELECT COALESCE(SUM(length(v)),0) FROM user_kv WHERE user_id=u.id) bytes,
          (SELECT COUNT(*) FROM sessions WHERE user_id=u.id AND expires_at>?) sessions FROM users u ORDER BY u.id`).bind(now).all();
      return ok({ users: r.results, me: me.id });
    }
    if (p === '/api/admin/settings') {
      if (m === 'GET') return ok({ signup: await getSetting(env, 'signup', 'approval') });
      if (m === 'PUT') {
        if (!['open', 'approval', 'closed'].includes(body.signup)) throw err(400, '잘못된 설정입니다.');
        await DB.prepare('INSERT INTO app_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind('signup', body.signup).run();
        return ok({ ok: true });
      }
    }
    const mm = p.match(/^\/api\/admin\/users\/(\d+)(\/[a-z]+)?$/);
    if (mm) {
      const id = +mm[1], sub = mm[2] || '';
      const t = await DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
      if (!t) throw err(404, '회원을 찾을 수 없습니다.');
      const admins = (await DB.prepare(`SELECT COUNT(*) n FROM users WHERE role='admin' AND status='active'`).first()).n;
      const lastAdmin = t.role === 'admin' && t.status === 'active' && admins <= 1;
      if (sub === '' && m === 'PATCH') {
        const role = body.role ?? t.role, status = body.status ?? t.status;
        if (!['user', 'admin'].includes(role) || !['active', 'pending', 'disabled'].includes(status)) throw err(400, '잘못된 값입니다.');
        if (id === me.id && (role !== 'admin' || status !== 'active')) throw err(400, '자신의 권한이나 상태는 바꿀 수 없습니다.');
        if (lastAdmin && (role !== 'admin' || status !== 'active')) throw err(400, '마지막 관리자는 해제할 수 없습니다.');
        const stmts = [DB.prepare('UPDATE users SET role=?, status=? WHERE id=?').bind(role, status, id)];
        if (status !== 'active') stmts.push(DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id));
        await DB.batch(stmts);
        return ok({ ok: true });
      }
      if (sub === '/password' && m === 'POST') {
        const np = String(body.password || ''); if (np.length < 8) throw err(400, '비밀번호는 8자 이상이어야 합니다.');
        const { salt, hash } = await makePw(np, env);
        await DB.batch([
          DB.prepare('UPDATE users SET pw_hash=?, pw_salt=?, fail_count=0, locked_until=0 WHERE id=?').bind(hash, salt, id),
          DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id)
        ]);
        return ok({ ok: true });
      }
      if (sub === '/logout' && m === 'POST') { await DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run(); return ok({ ok: true }); }
      if (sub === '/unlock' && m === 'POST') {
        const tu = await DB.prepare('SELECT username FROM users WHERE id=?').bind(id).first(), uk = String(tu ? tu.username : '').toLowerCase();
        await DB.batch([DB.prepare('UPDATE users SET fail_count=0, locked_until=0 WHERE id=?').bind(id), DB.prepare('DELETE FROM rate_limit WHERE k=? OR k LIKE ?').bind('lg:' + uk, 'lf:' + uk + '|%')]);
        return ok({ ok: true });
      }
      if (sub === '' && m === 'DELETE') {
        if (id === me.id) throw err(400, '자기 자신은 삭제할 수 없습니다.');
        if (lastAdmin) throw err(400, '마지막 관리자는 삭제할 수 없습니다.');
        await DB.batch([
          DB.prepare('DELETE FROM user_kv WHERE user_id=?').bind(id),
          DB.prepare('DELETE FROM user_tg WHERE user_id=?').bind(id),
          DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
          DB.prepare('DELETE FROM users WHERE id=?').bind(id)
        ]);
        return ok({ ok: true });
      }
    }
  }
  throw err(404, '없는 API입니다.');
}

/* ---------------- Yahoo 재무 데이터 (crumb 인증 자동 처리) ---------------- */
const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
let YF = { cookie: '', crumb: '', t: 0 };
async function yfAuth(force) {
  if (!force && YF.crumb && Date.now() - YF.t < 3600e3) return YF;
  const r = await fetch('https://fc.yahoo.com', { headers: { 'user-agent': YF_UA }, redirect: 'manual' });
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']).map(c => c.split(';')[0]).filter(Boolean).join('; ');
  const c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { cookie, 'user-agent': YF_UA } });
  const crumb = (await c.text()).trim();
  if (!crumb || /<|Too Many/.test(crumb)) throw err(502, 'Yahoo 인증값을 받지 못했습니다.');
  YF = { cookie, crumb, t: Date.now() }; return YF;
}
async function yfProxy(req, env, url) {
  const path = url.searchParams.get('path') || '';
  if (!/^\/(v7\/finance\/quote|v10\/finance\/quoteSummary\/|ws\/fundamentals-timeseries\/)/.test(path)) throw err(403, '허용되지 않은 경로입니다.');
  const go = async force => { const a = await yfAuth(force); return fetch('https://query1.finance.yahoo.com' + path + (path.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(a.crumb), { headers: { cookie: a.cookie, 'user-agent': YF_UA, 'Accept': 'application/json' } }); };
  let r = await go(false);
  if (r.status === 401 || r.status === 403) r = await go(true);   // 인증값이 만료됐으면 새로 받아 한 번 더
  return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors(req, env) } });
}

/* ---------------- 시세 프록시 ---------------- */
async function proxy(req, env, url) {
  const u = url.searchParams.get('url');
  if (!u) return new Response('missing url', { status: 400, headers: cors(req, env) });
  let target; try { target = new URL(u); } catch { return new Response('bad url', { status: 400, headers: cors(req, env) }); }
  if (!PROXY_HOSTS.includes(target.hostname)) return new Response('forbidden', { status: 403, headers: cors(req, env) });
  const coin = !target.hostname.endsWith('yahoo.com');
  const r = await fetch(target.toString(), { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...(target.hostname.endsWith('naver.com') ? { 'Referer': 'https://m.stock.naver.com/' } : {}) }, cf: { cacheTtl: coin ? 1 : 5, cacheEverything: coin } });
  const h = new Headers(r.headers);
  Object.entries(cors(req, env)).forEach(([k, v]) => h.set(k, v));
  return new Response(r.body, { status: r.status, headers: h });
}

/* ---------------- 텔레그램 · 서버 가격 알림 (Cron Trigger, 1분마다) ---------------- */
async function tgSend(env, chat, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3500), disable_web_page_preview: true }) });
    return r.ok;
  } catch { return false; }
}
// 서버가 확인할 수 있는 경우: 코인(KRW→업비트, USDT→바이낸스), 주식(알림 통화가 거래 통화와 같을 때). 그 밖의 알림은 앱이 열려 있을 때만 동작합니다.
async function alertPrice(type, symbol, q) {
  if (type === 'crypto') {
    if (q === 'KRW') { const j = await (await fetch(`https://api.upbit.com/v1/ticker?markets=KRW-${encodeURIComponent(symbol)}`)).json(); return j && j[0] ? { p: +j[0].trade_price, ccy: 'KRW' } : null; }
    if (q === 'USDT') { const j = await (await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}USDT`)).json(); return j && j.price ? { p: +j.price, ccy: 'USDT' } : null; }
    return null;
  }
  const j = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`, { headers: { 'user-agent': YF_UA } })).json();
  const mt = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  return mt && mt.regularMarketPrice ? { p: +mt.regularMarketPrice, ccy: mt.currency } : null;
}
async function runAlerts(env) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return;
  await init(env);
  const rows = (await env.DB.prepare(`SELECT k.user_id, k.k, k.v, t.chat_id FROM user_kv k JOIN user_tg t ON t.user_id = k.user_id JOIN users u ON u.id = k.user_id WHERE k.k LIKE 'palert:%' AND u.status = 'active'`).all()).results || [];
  const cache = new Map(), writes = [], now = Date.now(); let fetches = 0, sends = 0;
  for (const r of rows) {
    let list; try { list = JSON.parse(r.v); } catch { continue; }
    if (!Array.isArray(list) || !list.some(a => a && !a.triggered)) continue;
    const [type, ...rest] = r.k.slice(7).split(':'); if (!type || !rest.length) continue;
    const symbol = rest.join(':'); let changed = false;
    for (const al of list) {
      if (!al || al.triggered || !(al.price > 0)) continue;
      const ck = `${type}|${symbol}|${al.q || ''}`;
      if (!cache.has(ck)) { if (fetches >= 30) continue; fetches++; cache.set(ck, await alertPrice(type, symbol, al.q).catch(() => null)); }
      const px = cache.get(ck); if (!px) continue;
      if (type !== 'crypto' && al.c && px.ccy && al.c !== px.ccy) continue;   // 환산 통화로 만든 알림은 서버가 판단하지 않음
      if (!(al.dir === 'above' ? px.p >= al.price : px.p <= al.price) || sends >= 20) continue;
      sends++;
      const sent = await tgSend(env, r.chat_id, `🔔 ${symbol} ${al.dir === 'above' ? '≥' : '≤'} ${al.price.toLocaleString('en-US')} ${px.ccy || ''}\n현재가 ${px.p.toLocaleString('en-US')}${al.note ? '\n메모: ' + String(al.note).slice(0, 80) : ''}`);
      if (sent) { al.triggered = true; al.by = 'server'; changed = true; }
    }
    if (changed) writes.push(env.DB.prepare('UPDATE user_kv SET v=?, updated_at=? WHERE user_id=? AND k=?').bind(JSON.stringify(list), now, r.user_id, r.k));
  }
  if (writes.length) await env.DB.batch(writes);
}
