// Простой самодостаточный вход по общему паролю.
//
// Дашборд закрыт от посторонних без внешних зависимостей и без обращения к
// таблицам Supabase: пользователь один раз вводит общий пароль (env
// ACCESS_PASSWORD), сервер ставит подписанную HMAC-cookie, и дальше все
// запросы проходят по ней. Никакие ключи и пароли в браузер не попадают.
//
// Если ACCESS_PASSWORD не задан, вход отключён (режим для локальной разработки
// и тестов) — при старте сервер выводит явное предупреждение.

import crypto from "node:crypto";

const COOKIE_NAME = "ob_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
// Секрет для подписи cookie. Приоритет: явный SESSION_SECRET → производный от
// общего пароля (смена пароля инвалидирует старые сессии) → производный от
// сервис-ключа Supabase (чтобы вход по личным кодам работал даже без общего
// пароля). Пустой — только когда сервер вообще не настроен (локальный dev/тесты).
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (ACCESS_PASSWORD
    ? crypto.createHash("sha256").update("ob-salt::" + ACCESS_PASSWORD).digest("hex")
    : process.env.SUPABASE_SERVICE_ROLE_KEY
      ? crypto
          .createHash("sha256")
          .update("ob-salt::svc::" + process.env.SUPABASE_SERVICE_ROLE_KEY)
          .digest("hex")
      : "");

// Общий пароль доступа (админ/наблюдатель). Личные коды бухгалтеров проверяются
// отдельно по таблице login_codes (см. server.js).
export const authEnabled = Boolean(ACCESS_PASSWORD);

// Вход в приложение требуется, если задан общий пароль ИЛИ доступен сервис-ключ
// (тогда работает вход по личным кодам). Без обоих — открытый режим для локальной
// разработки и тестов.
export const loginRequired = Boolean(
  ACCESS_PASSWORD || process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Сравнение строк за постоянное время — защита от подбора пароля по времени.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function checkPassword(candidate) {
  if (!authEnabled) return true;
  return safeEqual(candidate || "", ACCESS_PASSWORD);
}

// Токен = base64(expiry).hmac(expiry). Проверяем срок и подпись.
export function issueToken(now = Date.now()) {
  const expiry = now + SESSION_TTL_MS;
  const payload = String(expiry);
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function verifyToken(token, now = Date.now()) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return false;
  }
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  if (!safeEqual(sig, expected)) return false;
  const expiry = Number(payload);
  if (!Number.isFinite(expiry) || expiry < now) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Серверная сессия с идентичностью бухгалтера.
// Токен = base64url(JSON).hmac(base64url). В payload храним:
//   { exp, emp?: employee_id (uuid), adm?: boolean, name?: string }
// Идентичность бухгалтера проверяется ТОЛЬКО на сервере (подпись HMAC); данные
// из формы браузера напрямую не используются для авторизации действий.
// ---------------------------------------------------------------------------
export function signSession(payload = {}, now = Date.now()) {
  const body = { ...payload, exp: now + SESSION_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("hex");
  return `${b64}.${sig}`;
}

export function readSession(token, now = Date.now()) {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("hex");
  if (!safeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (!Number.isFinite(payload.exp) || payload.exp < now) return null;
  return payload;
}

// Разбор Cookie-заголовка без внешних зависимостей.
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // HttpOnly — недоступна из JS; SameSite=Lax — защита от CSRF; Secure в проде.
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Сессия текущего запроса (или null). Читает подписанную cookie.
export function getSession(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return readSession(cookies[COOKIE_NAME]);
}

export function isAuthed(req) {
  if (!loginRequired) return true; // открытый режим (локальный dev/тесты)
  return Boolean(getSession(req));
}

export { COOKIE_NAME };

// ---------------------------------------------------------------------------
// Простое ограничение частоты запросов (rate limiting) в памяти процесса.
// Скользящее окно на IP. Без внешних зависимостей — этого достаточно для
// одного инстанса на Render. Защищает /api от случайного или намеренного флуда.
// ---------------------------------------------------------------------------
export function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map(); // ip -> [timestamps]
  return function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);

    // Периодическая уборка старых записей, чтобы Map не рос бесконечно.
    if (hits.size > 5000) {
      for (const [key, ts] of hits) {
        if (ts.every((t) => now - t >= windowMs)) hits.delete(key);
      }
    }

    if (arr.length > max) {
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ ok: false, error: "Слишком много запросов, попробуйте позже." });
    }
    next();
  };
}
