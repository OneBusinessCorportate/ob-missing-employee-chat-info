// Ежедневная сводка в Telegram.
//
// Отправляет ТОЛЬКО короткую сводку + ссылку на дашборд — никогда полный
// список. Запускается раз в день как Render Cron Job.
//
// Обязательные env:
//   TELEGRAM_BOT_TOKEN  - бот, который постит сводку
//   TELEGRAM_CHAT_ID    - чат/группа, куда постим
//   PLATFORM_URL        - публичный URL дашборда (ссылка в сообщении)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - для чтения чатов
//
// Необязательные:
//   DRY_RUN=1           - напечатать сообщение вместо отправки
//   REPORT_STATE_FILE   - путь к файлу состояния для идемпотентности
//                         (не слать повторно, если за сегодня уже слали)

import fs from "node:fs";
import { getProblemChats } from "../lib/problemChats.js";
import { getClientChecks } from "../lib/clientChecks.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PLATFORM_URL = process.env.PLATFORM_URL || "";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const STATE_FILE = process.env.REPORT_STATE_FILE || "";

// --- Структурированное логирование (одна JSON-строка на событие) ---------
function log(level, event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function buildMessage(counts, platformUrl = PLATFORM_URL) {
  // Путь «0 проблем» — позитивное сообщение, а не пустой отчёт.
  if (counts.total_problems === 0) {
    // Отдельный случай: реальных чатов вообще нет (например, есть только
    // тестовые, которые исключаются) — чтобы не создавать ложного «всё ок».
    let msg =
      counts.total_chats === 0
        ? "ℹ️ Чатов для проверки пока нет."
        : "✅ Все чаты в порядке — проблемных чатов нет.";
    if (platformUrl) {
      msg += `\n\nЧтобы увидеть больше информации, перейдите по ссылке:\n${platformUrl}`;
    }
    return msg;
  }

  const lines = [
    "📋 Ежедневная проверка ответственных в чатах",
    "",
    `Всего чатов проверено: ${counts.total_chats}`,
    `Чатов с неполной информацией: ${counts.total_problems}`,
    "",
    `• ${counts.missing_accountant} без бухгалтера`,
    `• ${counts.missing_head_accountant} без главного бухгалтера`,
    `• ${counts.missing_manager} без менеджера`,
  ];
  // Отдельно упоминаем чаты без данных, чтобы их не путали с проблемными.
  if (counts.not_checked) {
    lines.push("", `⚠️ Не проверено (нет данных): ${counts.not_checked}`);
  }
  lines.push(
    "",
    "Чтобы увидеть больше информации, перейдите по ссылке:",
    platformUrl || "(ссылка на платформу не настроена — задайте PLATFORM_URL)",
  );
  return lines.join("\n");
}

// В коротких списках показываем максимум столько первых проблемных клиентов —
// полный список остаётся на дашборде. Держим сообщение компактным для Telegram.
const CLIENT_CHECK_PREVIEW = 10;

// Отдельный НОВЫЙ блок «Ежедневная проверка клиентов/чатов» по данным Agreements
// (mqa_chats). Не трогает остальную логику отчёта — просто добавляется к нему.
// Под каждым пунктом — до CLIENT_CHECK_PREVIEW первых клиентов, дальше «…и ещё N»;
// полный список — по ссылке на дашборд.
export function buildClientChecksBlock(checks, platformUrl = PLATFORM_URL) {
  const c = checks.counts;
  const lines = [
    "📌 Ежедневная проверка клиентов/чатов",
    "",
    `Чаты без ответственных: ${c.no_responsible}`,
    `Нет HVHH в Agreements: ${c.no_hvhh}`,
    `Нет чатов у активных месячных клиентов: ${c.no_chat}`,
  ];
  if (c.needs_review) {
    lines.push(`Needs review (не удалось сопоставить): ${c.needs_review}`);
  }

  const section = (title, items, fmt) => {
    if (!items || !items.length) return;
    lines.push("", `${title}:`);
    for (const it of items.slice(0, CLIENT_CHECK_PREVIEW)) {
      lines.push(`• ${fmt(it)}`);
    }
    if (items.length > CLIENT_CHECK_PREVIEW) {
      lines.push(`…и ещё ${items.length - CLIENT_CHECK_PREVIEW}`);
    }
  };

  const whoMissing = (m) =>
    m === "both" ? "оба" : m === "accountant" ? "бухгалтер" : "менеджер";
  const hvhhSuffix = (hvhh) => (hvhh ? `, HVHH ${hvhh}` : "");

  section("Чаты без ответственных", checks.noResponsible, (it) =>
    `${it.client}${hvhhSuffix(it.hvhh)} — нет: ${whoMissing(it.missing)}`,
  );
  section("Нет HVHH в Agreements", checks.noHvhh, (it) =>
    `${it.client}${it.agr_no ? ` (${it.agr_no})` : ""}`,
  );
  section("Нет чатов у активных месячных клиентов", checks.noChat, (it) =>
    `${it.client}${hvhhSuffix(it.hvhh)}`,
  );

  if (platformUrl) {
    lines.push("", "Полный список — на дашборде:", platformUrl);
  }
  return lines.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Отправка с повторами и экспоненциальной задержкой. Повторяем при сетевых
// ошибках, 429 (учитываем retry_after) и 5xx. При 4xx (кроме 429) не повторяем —
// это ошибка запроса, которую повтор не исправит.
async function sendTelegram(text, { attempts = 4, baseDelayMs = 1000 } = {}) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        log("info", "telegram_sent", { attempt, message_id: body.result?.message_id });
        return body;
      }
      const retriable = res.status === 429 || res.status >= 500;
      lastErr = new Error(`Telegram sendMessage failed: ${res.status} ${JSON.stringify(body)}`);
      if (!retriable || attempt === attempts) throw lastErr;
      // Telegram может подсказать, сколько ждать, в parameters.retry_after (сек).
      const retryAfter = body.parameters?.retry_after;
      const delay = retryAfter ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1);
      log("warn", "telegram_retry", { attempt, status: res.status, delay_ms: delay });
      await sleep(delay);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) throw lastErr;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      log("warn", "telegram_retry", { attempt, error: err.message, delay_ms: delay });
      await sleep(delay);
    }
  }
  throw lastErr;
}

// --- Идемпотентность: не слать сводку дважды за один день ------------------
function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
function alreadySentToday() {
  if (!STATE_FILE) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return saved.last_sent_date === todayKey();
  } catch {
    return false;
  }
}
function markSentToday() {
  if (!STATE_FILE) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ last_sent_date: todayKey() }));
  } catch (err) {
    log("warn", "state_write_failed", { error: err.message });
  }
}

async function main() {
  const { counts } = await getProblemChats();
  let message = buildMessage(counts);
  log("info", "report_built", { ...counts });

  // Новый блок «Ежедневная проверка клиентов/чатов» по данным Agreements.
  // Считаем и добавляем его к сообщению. Если источник недоступен — логируем и
  // отправляем остальной отчёт без этого блока (не роняем всю сводку).
  try {
    const checks = await getClientChecks();
    message += "\n\n" + buildClientChecksBlock(checks);
    log("info", "client_checks_built", { ...checks.counts });
  } catch (err) {
    log("error", "client_checks_failed", { error: err.message });
  }

  console.log("---- Daily summary ----\n" + message + "\n-----------------------");

  if (DRY_RUN) {
    log("info", "dry_run_skip_send");
    return;
  }

  if (alreadySentToday()) {
    log("info", "idempotent_skip", { date: todayKey() });
    return;
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set to send the summary (or set DRY_RUN=1 to test).",
    );
  }

  await sendTelegram(message);
  markSentToday();
  log("info", "report_done");
}

// Запускаем main только при прямом вызове файла — чтобы buildMessage можно
// было импортировать в тестах без побочных эффектов.
const isDirectRun =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    log("error", "report_failed", { error: err.message });
    process.exit(1);
  });
}
