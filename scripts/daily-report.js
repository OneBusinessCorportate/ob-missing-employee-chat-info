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
import { loadReportData } from "../lib/ticketReview.js";
import { buildTicketReport } from "../lib/ticketReport.js";

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

export function buildMessage(counts, platformUrl = PLATFORM_URL, clientCounts = null) {
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
    `У нас есть ${counts.total_problems} проблемных чатов, из которых:`,
    "",
    `${counts.missing_accountant} без бухгалтера`,
    `${counts.missing_head_accountant} без главного бухгалтера`,
    `${counts.missing_manager} без менеджера`,
  ];
  // Две дополнительные метрики из Agreements (mqa_chats) в том же списке.
  if (clientCounts) {
    lines.push(
      `${clientCounts.no_hvhh} нет HVHH в Agreements`,
      `${clientCounts.no_chat} нет чатов у активных месячных клиентов`,
    );
  }
  lines.push(
    "",
    "Чтобы увидеть больше информации, перейдите по ссылке:",
    platformUrl || "(ссылка на платформу не настроена — задайте PLATFORM_URL)",
  );
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

// --- Идемпотентность: не слать отчёт дважды за один отчётный день -----------
// Ключ — отчётная дата (вчера в Asia/Yerevan, YYYY-MM-DD), а не UTC-«сегодня»,
// чтобы совпадать с содержимым отчёта независимо от часового пояса сервера.
function alreadySent(reportKey) {
  if (!STATE_FILE) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return saved.last_sent_date === reportKey;
  } catch {
    return false;
  }
}
function markSent(reportKey) {
  if (!STATE_FILE) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ last_sent_date: reportKey }));
  } catch (err) {
    log("warn", "state_write_failed", { error: err.message });
  }
}

async function main() {
  const { counts } = await getProblemChats();
  log("info", "report_built", { ...counts });

  // Доп. метрики по данным Agreements (mqa_chats) — обязательная часть ПОЛНОЙ
  // сводки: две строки в основном списке (HVHH и чаты активных клиентов).
  //
  // Короткого/усечённого варианта больше нет. Раньше при сбое источника мы слали
  // сокращённый отчёт без этих цифр, но он выглядел как старый короткий формат и
  // вводил получателей в заблуждение. Теперь, если источник недоступен (уже после
  // повторов внутри getClientChecks), сводка НЕ отправляется — ошибка
  // пробрасывается и крон падает, чтобы проблему было видно, а не замаскировано
  // «старым» форматом. Отправляем только полный, новый формат — либо ничего.
  const checks = await getClientChecks();
  const message = buildMessage(counts, PLATFORM_URL, checks.counts);
  log("info", "client_checks_built", { ...checks.counts });

  // Отчёт по тикетам за вчера (Asia/Yerevan) — по одной секции на бухгалтера.
  // Использует ту же общую логику, что и серверный гейт (lib/ticketReview.js),
  // поэтому цифры на дашборде разбора и в Telegram не расходятся.
  const report = await loadReportData();
  const ticketMessages = buildTicketReport(report.accountants, {
    label: report.range.label,
    dashboardUrl: PLATFORM_URL,
  });
  log("info", "ticket_report_built", {
    report_date: report.range.ymd,
    accountants: report.accountants.length,
    messages: ticketMessages.length,
  });

  console.log("---- Daily summary ----\n" + message + "\n-----------------------");
  console.log("---- Ticket report ----\n" + ticketMessages.join("\n\n") + "\n-----------------------");

  if (DRY_RUN) {
    log("info", "dry_run_skip_send");
    return;
  }

  // Идемпотентность — по отчётной дате (вчера, Yerevan).
  if (alreadySent(report.range.ymd)) {
    log("info", "idempotent_skip", { report_date: report.range.ymd });
    return;
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set to send the summary (or set DRY_RUN=1 to test).",
    );
  }

  // Сначала отчёт по тикетам (может быть несколько сообщений при большом объёме),
  // затем существующая сводка по проблемным чатам.
  for (const part of ticketMessages) await sendTelegram(part);
  await sendTelegram(message);
  markSent(report.range.ymd);
  log("info", "report_done", { report_date: report.range.ymd });
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
