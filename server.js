// Минимальный веб-сервис на Express:
//   GET  /                     -> дашборд проблемных чатов, ОТКРЫТ ДЛЯ ВСЕХ (без входа)
//   GET  /api/problem-chats    -> JSON со списком проблемных чатов и счётчиками (открыт)
//   GET  /login                -> страница входа (личный код + общий пароль)
//   POST /login                -> проверка пароля + резолв личного кода, cookie
//   POST /logout               -> выход
//   GET  /review-tickets       -> страница разбора вчерашних тикетов (нужен вход)
//   GET  /api/review/tickets   -> вчерашние необработанные тикеты бухгалтера
//   GET  /api/review/progress  -> прогресс обработки
//   POST /api/review/accept    -> «Принять» тикет
//   POST /api/review/appeal    -> «Подать апелляцию» (обязательный комментарий)
//   GET  /healthz              -> health-check для Render (всегда открыт)
//
// Серверный ключ Supabase остаётся на сервере; браузер общается только с API и
// никогда не видит ни ключ, ни личность в открытом (неподписанном) виде.
//
// Дашборд проблемных чатов открыт для всех — вход/пароль для его просмотра не
// нужны, чтобы каждый мог видеть проблемные чаты любого менеджера и фильтровать
// их по владельцу. Личный вход (код) остаётся только для персонального разбора
// тикетов (accept/appeal), где нужно достоверно знать, КТО отвечает.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProblemChats } from "./lib/problemChats.js";
import { getClientChecks } from "./lib/clientChecks.js";
import { getClientCount } from "./lib/clientCount.js";
import {
  authEnabled,
  checkPassword,
  isAuthed,
  sessionCookie,
  clearCookie,
  createRateLimiter,
  signIdentity,
  identityFromReq,
} from "./lib/auth.js";
import { resolveLoginCode, isSupervisor } from "./lib/identity.js";
import {
  getGateState,
  acceptTicket,
  appealTicket,
  severityOf,
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

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health-check полностью открыт — его дёргает Render.
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- Вход ---------------------------------------------------------------
app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Ограничиваем попытки входа, чтобы нельзя было подбирать код/пароль перебором.
const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
app.post("/login", loginLimiter, async (req, res) => {
  const password = (req.body && req.body.password) || "";
  const code = (req.body && req.body.code) || "";

  // 1) Общий пароль (если включён) — «замок» на весь дашборд.
  if (authEnabled && !checkPassword(password)) {
    return res.redirect("/login?error=pass");
  }

  // 2) Личный код — достоверная ЛИЧНОСТЬ бухгалтера. Обязателен: без неё
  //    персональная блокировка невозможна. Резолвим ТОЛЬКО на сервере.
  try {
    const identity = await resolveLoginCode(code);
    if (!identity) return res.redirect("/login?error=code");
    res.set("Set-Cookie", sessionCookie(signIdentity(identity)));
    return res.redirect("/");
  } catch (err) {
    console.error("[/login] resolve code failed", err);
    return res.redirect("/login?error=server");
  }
});

app.post("/logout", (req, res) => {
  res.set("Set-Cookie", clearCookie());
  res.redirect("/login");
});

// --- Базовая защита входом ------------------------------------------------
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "Требуется вход." });
  }
  return res.redirect("/login");
}

// Требует достоверную личность бухгалтера (для персональных API разбора).
function requireAccountant(req, res, next) {
  const acc = identityFromReq(req);
  if (!acc) {
    return res.status(401).json({ ok: false, error: "Требуется вход бухгалтера." });
  }
  req.accountant = acc;
  next();
}

// ---------------------------------------------------------------------------
// Обязательный разбор вчерашних тикетов. Эти маршруты РЕГИСТРИРУЮТСЯ ДО gate,
// поэтому заблокированный бухгалтер может ими пользоваться (иначе — тупик).
// Страница отдаётся как самодостаточный HTML (стили/скрипты внутри), чтобы не
// зависеть от статики, которая закрыта за gate.
// ---------------------------------------------------------------------------
app.get("/review-tickets", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "review-tickets.html"));
});

const reviewReadLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const reviewWriteLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

// Публичное (безопасное) представление тикета — без внутренних полей.
function publicTicket(t) {
  return {
    problem_id: t.problem_id,
    source: t.source,
    client_name: t.client_name || null,
    chat_name: t.chat_name || null,
    chat_id: t.contract_id || null,
    chat_link: t.chat_link || null,
    problem_title: t.problem_title || null,
    problem_description: t.problem_description || null,
    evidence: t.ai_comment || null,
    detected_at: t.detected_at || null,
    severity: severityOf(t.priority),
    accountant_name: t.accountant_name || null,
    status: t.status || null,
  };
}

function progressPayload(state) {
  return {
    total: state.total,
    answered: state.accepted + state.appealed,
    accepted: state.accepted,
    appealed: state.appealed,
    remaining: state.unanswered,
    complete: state.complete,
  };
}

app.get(
  "/api/review/tickets",
  requireAuth,
  requireAccountant,
  reviewReadLimiter,
  async (req, res) => {
    try {
      const state = await getGateState(req.accountant);
      res.set("Cache-Control", "no-store");
      res.json({
        ok: true,
        accountant: { full_name: req.accountant.full_name },
        supervisor: isSupervisor(req.accountant),
        progress: progressPayload(state),
        tickets: state.unansweredTickets.map(publicTicket),
      });
    } catch (err) {
      console.error("[/api/review/tickets]", err);
      res.status(500).json({ ok: false, error: "Не удалось загрузить тикеты." });
    }
  },
);

app.get(
  "/api/review/progress",
  requireAuth,
  requireAccountant,
  reviewReadLimiter,
  async (req, res) => {
    try {
      const state = await getGateState(req.accountant);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, progress: progressPayload(state) });
    } catch (err) {
      console.error("[/api/review/progress]", err);
      res.status(500).json({ ok: false, error: "Не удалось получить прогресс." });
    }
  },
);

// Безопасные тексты ошибок (без деталей БД).
const REVIEW_ERROR_TEXT = {
  not_found: "Тикет не найден.",
  forbidden: "Это не ваш тикет.",
  not_eligible: "Тикет не требует обработки.",
  not_in_review_window: "Тикет не относится ко вчерашнему дню.",
  comment_required: "Нужен комментарий к апелляции.",
  comment_too_long: "Комментарий слишком длинный.",
  already_accepted: "Тикет уже принят.",
  already_appealed: "По тикету уже подана апелляция.",
  bad_action: "Некорректное действие.",
};

async function handleReviewWrite(req, res, action) {
  const problemId = (req.body && req.body.problem_id) || "";
  if (!problemId) {
    return res.status(400).json({ ok: false, error: "Не указан тикет." });
  }
  try {
    const result =
      action === "accept"
        ? await acceptTicket(problemId, req.accountant, {
            note: (req.body && req.body.comment) || null,
          })
        : await appealTicket(problemId, req.accountant, {
            comment: (req.body && req.body.comment) || "",
          });

    if (!result || result.ok === false) {
      const code = (result && result.error) || "bad_action";
      const status = code === "forbidden" ? 403 : code === "not_found" ? 404 : 409;
      return res
        .status(status)
        .json({ ok: false, error: REVIEW_ERROR_TEXT[code] || "Не удалось выполнить." });
    }

    // Пересчёт прогресса на сервере → мгновенная разблокировка на фронте.
    const state = await getGateState(req.accountant);
    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      status: result.status,
      duplicate: Boolean(result.duplicate),
      progress: progressPayload(state),
    });
  } catch (err) {
    console.error(`[/api/review/${action}]`, err);
    return res.status(500).json({ ok: false, error: "Внутренняя ошибка. Попробуйте позже." });
  }
}

app.post(
  "/api/review/accept",
  requireAuth,
  requireAccountant,
  reviewWriteLimiter,
  (req, res) => handleReviewWrite(req, res, "accept"),
);
app.post(
  "/api/review/appeal",
  requireAuth,
  requireAccountant,
  reviewWriteLimiter,
  (req, res) => handleReviewWrite(req, res, "appeal"),
);

// ---------------------------------------------------------------------------
// Дашборд проблемных чатов — ОТКРЫТ ДЛЯ ВСЕХ. Ни входа, ни пароля, ни блокировки
// по тикетам для его просмотра нет: любой может открыть страницу и API и увидеть
// проблемные чаты всех менеджеров (с фильтром по владельцу чата). Персональный
// разбор тикетов (accept/appeal) остаётся закрыт входом — он зарегистрирован
// ВЫШЕ и требует достоверной личности.
// ---------------------------------------------------------------------------
const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
app.get("/api/problem-chats", apiLimiter, async (_req, res) => {
  try {
    const { problems, notChecked, counts, byManager } = await getProblemChats();

    // Доп. метрики из Agreements (mqa_chats) — ровно те же две цифры, что и в
    // ежедневной Telegram-сводке (getClientChecks): «нет HVHH в Agreements» и
    // «нет чатов у активных месячных клиентов». Показываем их и на дашборде,
    // чтобы каждая строка сводки имела здесь свой видимый, кликабельный аналог.
    //
    // Best-effort: сбой ЭТОГО источника не должен ронять весь дашборд —
    // основной чек-лист (проблемные чаты) остаётся доступен. Если чтение не
    // удалось, отдаём client_checks=null и текст ошибки для диагностики.
    let clientChecks = null;
    let clientChecksError = null;
    try {
      const cc = await getClientChecks();
      clientChecks = { counts: cc.counts, no_hvhh: cc.noHvhh, no_chat: cc.noChat };
    } catch (err) {
      clientChecksError = err.message;
      console.error("[/api/problem-chats] client checks failed", err);
    }

    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      counts,
      chats: problems,
      by_manager: byManager || [],
      not_checked: notChecked || [],
      client_checks: clientChecks,
      client_checks_error: clientChecksError,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[/api/problem-chats]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Контроль количества клиентов — сравнение ВСЕХ компаний из всех источников
// (снимки xlsx в data/recon + живые данные OB FAQ Supabase). Как и дашборд
// проблемных чатов, страница и её API ОТКРЫТЫ ДЛЯ ВСЕХ (только чтение, ключ
// Supabase остаётся на сервере). Страница отдаётся до статики, чтобы иметь
// собственный маршрут.
// ---------------------------------------------------------------------------
const clientCountLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
app.get("/client-count", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "client-count.html"));
});
app.get("/api/client-count", clientCountLimiter, async (_req, res) => {
  try {
    const data = await getClientCount();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[/api/client-count]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Одноразовый вход в Telegram по номеру (для Render) ------------------
// В отличие от дашборда, этот мощный поток (аутентификация Telegram-аккаунта)
// остаётся ПОД ВХОДОМ (requireAuth) — открытым его делать нельзя. Плюс feature-
// флаг TELEGRAM_LOGIN_ENABLED и ограничение частоты.
function requireLoginFeature(_req, res, next) {
  if (!loginEnabled()) {
    return res
      .status(404)
      .json({ ok: false, error: "Вход отключён. Задайте TELEGRAM_LOGIN_ENABLED=1." });
  }
  next();
}

const tgLoginLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

app.get("/telegram-login", requireAuth, requireLoginFeature, (_req, res) => {
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
  requireAuth,
  requireLoginFeature,
  tgLoginLimiter,
  tgHandler((b) => beginLogin(b.phone)),
);
app.post(
  "/telegram-login/code",
  requireAuth,
  requireLoginFeature,
  tgLoginLimiter,
  tgHandler((b) => confirmCode(b.code)),
);
app.post(
  "/telegram-login/password",
  requireAuth,
  requireLoginFeature,
  tgLoginLimiter,
  tgHandler((b) => confirmPassword(b.password)),
);

// Статика (дашборд) — ОТКРЫТА ДЛЯ ВСЕХ (index.html = дашборд проблемных чатов).
app.use(express.static(path.join(__dirname, "public")));

// Запускаем сервер только при прямом вызове файла — чтобы server.js можно было
// импортировать в тестах без побочного app.listen (как это делает daily-report).
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Dashboard listening on port ${PORT}`);
    if (!authEnabled) {
      console.warn(
        "[auth] ВНИМАНИЕ: ACCESS_PASSWORD не задан — общий замок дашборда выключен. " +
          "Задайте ACCESS_PASSWORD в продакшене (Render).",
      );
    }
  });
}

export { app };
