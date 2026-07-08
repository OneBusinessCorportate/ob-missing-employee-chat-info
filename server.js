// Минимальный веб-сервис на Express:
//   GET  /             -> дашборд (статичный, mobile-friendly), под защитой входа
//   GET  /login        -> страница входа по общему паролю
//   POST /login        -> проверка пароля, установка подписанной cookie
//   POST /logout       -> выход
//   GET  /api/problem-chats -> JSON со списком проблемных чатов и счётчиками
//   GET  /healthz      -> health-check для Render (всегда открыт)
//
// Сервисный ключ Supabase остаётся на сервере; браузер общается только с
// /api/problem-chats и никогда не видит ключ.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProblemChats } from "./lib/problemChats.js";
import {
  authEnabled,
  checkPassword,
  issueToken,
  isAuthed,
  sessionCookie,
  clearCookie,
  createRateLimiter,
} from "./lib/auth.js";

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

// Ограничиваем попытки входа, чтобы нельзя было подбирать пароль перебором.
const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
app.post("/login", loginLimiter, (req, res) => {
  const password = (req.body && req.body.password) || "";
  if (!checkPassword(password)) {
    return res.status(401).redirect("/login?error=1");
  }
  res.set("Set-Cookie", sessionCookie(issueToken()));
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  res.set("Set-Cookie", clearCookie());
  res.redirect("/login");
});

// --- Защита остального ---------------------------------------------------
// Всё, что ниже, доступно только вошедшим (если вход включён).
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  // Для API отдаём 401 JSON, для страниц — редирект на форму входа.
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "Требуется вход." });
  }
  return res.redirect("/login");
}

const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
app.get("/api/problem-chats", requireAuth, apiLimiter, async (_req, res) => {
  try {
    const { problems, counts } = await getProblemChats();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, counts, chats: problems, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error("[/api/problem-chats]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Статика (дашборд) — тоже под защитой входа.
app.use(requireAuth, express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
  if (!authEnabled) {
    console.warn(
      "[auth] ВНИМАНИЕ: ACCESS_PASSWORD не задан — дашборд открыт без пароля. " +
        "Обязательно задайте ACCESS_PASSWORD в продакшене (Render).",
    );
  }
});
