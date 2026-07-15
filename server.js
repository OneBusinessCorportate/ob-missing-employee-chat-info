// Минимальный веб-сервис на Express:
//   GET  /             -> дашборд (статичный, mobile-friendly), под защитой входа
//   GET  /login        -> страница входа (личный код бухгалтера / общий пароль)
//   POST /login        -> проверка кода/пароля, установка подписанной cookie-сессии
//   POST /logout       -> выход
//   GET  /review       -> обязательная страница разбора вчерашних тикетов
//   GET  /api/review/tickets   -> необработанные вчерашние тикеты бухгалтера
//   GET  /api/review/progress  -> прогресс обработки (для гейта/страницы)
//   POST /api/review/accept    -> «Принять» тикет
//   POST /api/review/appeal    -> «Подать апелляцию» (с обязательным комментарием)
//   GET  /api/problem-chats    -> JSON со списком проблемных чатов и счётчиками
//   GET  /healthz      -> health-check для Render (всегда открыт)
//
// Сервисный ключ Supabase остаётся на сервере; браузер общается только с
// разрешёнными API и никогда не видит ключ. Обязательный гейт (разбор
// вчерашних тикетов) реализован на СЕРВЕРЕ — прямое открытие URL дашборда или
// защищённого API не обходит блокировку.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProblemChats } from "./lib/problemChats.js";
import {
  loginRequired,
  isAuthed,
  getSession,
  signSession,
  sessionCookie,
  clearCookie,
  createRateLimiter,
} from "./lib/auth.js";
import {
  lookupLoginCode,
  loadAccountantGate,
  fetchTicket,
  validateAnswer,
  submitAnswer,
  gateDecision,
  isGateExempt,
} from "./lib/ticketReview.js";
import {
  beginLogin,
  confirmCode,
  confirmPassword,
  loginEnabled,
} from "./lib/telegramLogin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Доверяем заголовку X-Forwarded-For от прокси Render — чтобы rate limiting
// видел реальный IP клиента, а не адрес прокси.
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health-check оставляем полностью открытым — его дёргает Render.
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- Вход ---------------------------------------------------------------
app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Ограничиваем попытки входа, чтобы нельзя было подбирать код перебором.
const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
// Вход ТОЛЬКО по личному коду (public.login_codes). Общий пароль больше не даёт
// доступ и не обходит гейт — единственный обход у кода с can_see_all
// (менеджер/админ). Идентичность проверяется на сервере и кладётся в
// подписанную сессию; данные из формы для авторизации не используются.
app.post("/login", loginLimiter, async (req, res) => {
  const code = ((req.body && (req.body.code ?? req.body.password)) || "")
    .toString()
    .trim();

  if (code && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const ident = await lookupLoginCode(code);
      if (ident && ident.active) {
        // adm=true только для кодов с can_see_all (менеджер/админ) — они обходят
        // обязательный разбор тикетов. Обычный бухгалтер (emp) — под гейтом.
        res.set(
          "Set-Cookie",
          sessionCookie(
            signSession({ emp: ident.employeeId, adm: ident.canSeeAll, name: ident.name }),
          ),
        );
        return res.redirect("/");
      }
    } catch (err) {
      console.error("[/login] lookupLoginCode", err.message);
    }
  }

  return res.status(401).redirect("/login?error=1");
});

app.post("/logout", (req, res) => {
  res.set("Set-Cookie", clearCookie());
  res.redirect("/login");
});

// --- Защита остального ---------------------------------------------------
// Всё, что ниже, доступно только вошедшим (если вход включён).
function requireAuth(req, res, next) {
  if (isAuthed(req)) {
    req.session = getSession(req) || null;
    return next();
  }
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "Требуется вход." });
  }
  return res.redirect("/login");
}
app.use(requireAuth);

// --- Обязательный разбор вчерашних тикетов (страница и API) --------------
// Эти маршруты зарегистрированы ДО гейта, поэтому остаются доступны заблокир.
// бухгалтеру — иначе он не смог бы ответить на тикеты (редирект-петля).
const reviewLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

app.get("/review", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "review.html"));
});

// Идентичность бухгалтера берём ТОЛЬКО из серверной сессии, не из тела запроса.
function accountantFromSession(req) {
  const s = req.session;
  if (!s || !s.emp) return null;
  return { employeeId: String(s.emp), name: s.name || null, admin: Boolean(s.adm) };
}

app.get("/api/review/progress", reviewLimiter, async (req, res) => {
  const acc = accountantFromSession(req);
  if (!acc) return res.json({ ok: true, applicable: false, done: true });
  try {
    const gate = await loadAccountantGate(acc.employeeId);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      applicable: true,
      done: gate.done,
      total: gate.total,
      answered: gate.answered,
      accepted: gate.accepted,
      appealed: gate.appealed,
      unanswered: gate.unanswered,
      date: gate.range.label,
    });
  } catch (err) {
    console.error("[/api/review/progress]", err.message);
    res.status(500).json({ ok: false, error: "Не удалось получить прогресс." });
  }
});

app.get("/api/review/tickets", reviewLimiter, async (req, res) => {
  const acc = accountantFromSession(req);
  if (!acc) return res.json({ ok: true, applicable: false, tickets: [], done: true });
  try {
    const gate = await loadAccountantGate(acc.employeeId);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      applicable: true,
      accountant: acc.name,
      date: gate.range.label,
      done: gate.done,
      total: gate.total,
      answered: gate.answered,
      unanswered: gate.unanswered,
      tickets: gate.tickets,
    });
  } catch (err) {
    console.error("[/api/review/tickets]", err.message);
    res.status(500).json({ ok: false, error: "Не удалось получить список тикетов." });
  }
});

// Безопасные русские сообщения по кодам ошибок (без деталей БД).
const ERROR_MESSAGES = {
  TICKET_NOT_FOUND: "Тикет не найден.",
  NOT_OWNER: "Этот тикет назначен другому бухгалтеру.",
  OUT_OF_RANGE: "Тикет не относится к обязательному дню разбора.",
  NOT_ELIGIBLE: "Тикет уже обработан или неактуален.",
  COMMENT_REQUIRED: "Для апелляции нужен непустой комментарий.",
  COMMENT_TOO_LONG: "Комментарий слишком длинный.",
  ALREADY_ACCEPTED: "Тикет уже принят — апелляция невозможна.",
  ALREADY_APPEALED: "По тикету уже подана апелляция — принять нельзя.",
  BAD_ACTION: "Некорректное действие.",
  NO_IDENTITY: "Не удалось определить бухгалтера.",
  DB_ERROR: "Внутренняя ошибка. Попробуйте ещё раз.",
};

async function handleAnswer(action, req, res) {
  const acc = accountantFromSession(req);
  if (!acc) return res.status(401).json({ ok: false, error: ERROR_MESSAGES.NO_IDENTITY });

  const problemId = (req.body && req.body.problem_id) || "";
  const comment = (req.body && req.body.comment) || "";
  if (!problemId) {
    return res.status(400).json({ ok: false, error: ERROR_MESSAGES.TICKET_NOT_FOUND });
  }

  try {
    const ticket = await fetchTicket(String(problemId));
    // Серверная валидация владельца/срока/статуса/комментария.
    const v = validateAnswer({ action, ticket, employeeId: acc.employeeId, comment });
    if (!v.ok) {
      return res
        .status(v.code === "NOT_OWNER" ? 403 : 400)
        .json({ ok: false, error: ERROR_MESSAGES[v.code] || v.error });
    }

    // Атомарная запись (advisory-lock, взаимоисключение принять/апелляция).
    const result = await submitAnswer({
      action,
      problemId: String(problemId),
      employeeId: acc.employeeId,
      accountantName: acc.name,
      comment: v.comment,
    });

    // Пересчитываем гейт на сервере — блок снимается сразу после последнего ответа.
    const gate = await loadAccountantGate(acc.employeeId);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      action,
      status: result.status || "ok",
      done: gate.done,
      total: gate.total,
      answered: gate.answered,
      unanswered: gate.unanswered,
    });
  } catch (err) {
    const code = err.code || "DB_ERROR";
    if (code === "DB_ERROR") console.error(`[/api/review/${action}]`, err.message);
    const status = code === "NOT_OWNER" ? 403 : code === "DB_ERROR" ? 500 : 409;
    res.status(status).json({ ok: false, error: ERROR_MESSAGES[code] || ERROR_MESSAGES.DB_ERROR });
  }
}

app.post("/api/review/accept", reviewLimiter, (req, res) => handleAnswer("accept", req, res));
app.post("/api/review/appeal", reviewLimiter, (req, res) => handleAnswer("appeal", req, res));

// --- Серверный гейт ------------------------------------------------------
// Блокирует обычного бухгалтера с необработанными вчерашними тикетами на всех
// защищённых страницах и API. Проверка идёт на сервере, обойти нельзя.
async function requireGateClear(req, res, next) {
  const s = req.session;
  // Быстрый выход без запроса к БД: нет сессии (решает requireAuth), путь-исключение
  // (вход/выход/страница и API разбора/health) или админ/менеджер (can_see_all).
  if (!s || isGateExempt(req.path)) return next();
  if (s.adm) return next();

  // По умолчанию считаем, что есть необработанные тикеты (fail-closed): при сбое
  // расчёта или без идентичности бухгалтера доступ НЕ открываем.
  let unanswered = 1;
  if (s.emp) {
    try {
      const gate = await loadAccountantGate(String(s.emp));
      unanswered = gate.unanswered;
    } catch (err) {
      console.error("[gate]", err.message);
    }
  }

  const decision = gateDecision({ session: s, unanswered, path: req.path });
  if (!decision.blocked) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(403).json({
      ok: false,
      error: "Перед началом работы необходимо обработать все тикеты за вчерашний день.",
      redirect: "/review",
    });
  }
  return res.redirect("/review");
}
app.use(requireGateClear);

// --- Защищённые ресурсы (после гейта) ------------------------------------
const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
app.get("/api/problem-chats", apiLimiter, async (_req, res) => {
  try {
    const { problems, notChecked, counts } = await getProblemChats();
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      counts,
      chats: problems,
      not_checked: notChecked || [],
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[/api/problem-chats]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Одноразовый вход в Telegram по номеру (для Render) ------------------
function requireLoginFeature(_req, res, next) {
  if (!loginEnabled()) {
    return res
      .status(404)
      .json({ ok: false, error: "Вход отключён. Задайте TELEGRAM_LOGIN_ENABLED=1." });
  }
  next();
}

const tgLoginLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

app.get("/telegram-login", requireLoginFeature, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "telegram-login.html"));
});

function tgHandler(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req.body || {});
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || "Ошибка входа." });
    }
  };
}

app.post(
  "/telegram-login/start",
  requireLoginFeature,
  tgLoginLimiter,
  tgHandler((b) => beginLogin(b.phone)),
);
app.post(
  "/telegram-login/code",
  requireLoginFeature,
  tgLoginLimiter,
  tgHandler((b) => confirmCode(b.code)),
);
app.post(
  "/telegram-login/password",
  requireLoginFeature,
  tgLoginLimiter,
  tgHandler((b) => confirmPassword(b.password)),
);

// Статика (дашборд) — тоже под защитой входа и гейта.
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
  if (!loginRequired) {
    console.warn(
      "[auth] ВНИМАНИЕ: ни ACCESS_PASSWORD, ни SUPABASE_SERVICE_ROLE_KEY не заданы — " +
        "вход отключён, гейт не применяется. Задайте их в продакшене (Render).",
    );
  }
});
