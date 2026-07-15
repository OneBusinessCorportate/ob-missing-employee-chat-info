// Формирование текста ежедневного отчёта по тикетам за вчера для Telegram.
//
// Использует ТОЛЬКО данные из lib/ticketReview.js (computeReport/loadReportData),
// поэтому счётчики в Telegram и на дашборде разбора всегда совпадают — отдельной
// логики подсчёта здесь нет.
//
// Отчёт: по одной секции на каждого бухгалтера, у кого вчера были тикеты, с
// количеством апелляций/принятых/без ответа и списками проблем по серьёзности.
// Сообщения безопасно делятся на части, чтобы не упереться в лимит Telegram и не
// разрезать строку тикета пополам.

import { SEVERITIES } from "./ticketReview.js";

// Лимит Telegram — 4096 символов на сообщение. Берём с запасом.
export const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 3800;

// Экранирование спецсимволов Telegram MarkdownV2 — на случай, если отправка
// пойдёт с parse_mode. По умолчанию отчёт шлётся как обычный текст (без
// parse_mode), но экранирование доступно и покрыто тестами.
const MDV2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
export function escapeMarkdownV2(text) {
  return String(text ?? "").replace(MDV2_SPECIAL, (ch) => "\\" + ch);
}

// Приводим текст к одной строке: убираем переносы/управляющие символы, схлопываем
// пробелы. Так строка тикета не ломает построчную разбивку и вёрстку сообщения.
export function sanitizeLine(text) {
  return String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Секция одного бухгалтера как массив строк (одна «строка» = один элемент).
export function buildAccountantSection(acc) {
  const lines = [];
  lines.push(`👤 ${sanitizeLine(acc.accountant_name || "(без имени)")}`);
  lines.push("");
  lines.push(`Апелляций: ${acc.appealed}`);
  lines.push(`Принято: ${acc.accepted}`);
  lines.push(`Без ответа: ${acc.unanswered}`);

  for (const sev of SEVERITIES) {
    const items = acc.severities[sev.key] || [];
    if (!items.length) continue; // пустые группы опускаем
    lines.push("");
    lines.push(`${sev.emoji} ${sev.label}: ${items.length}`);
    items.forEach((it, i) => {
      lines.push(`${i + 1}. Чат ${sanitizeLine(it.chat_code)} — ${sanitizeLine(it.text)}`);
    });
  }
  return lines;
}

// Разбивка длинного отчёта на несколько сообщений по границам строк — строка
// тикета никогда не разрезается. Если одна строка длиннее лимита — она всё равно
// уходит отдельным сообщением (жёстко не режем содержимое тикета посередине).
export function splitIntoMessages(lines, limit = SAFE_LIMIT) {
  const messages = [];
  let buf = [];
  let len = 0;
  const flush = () => {
    if (buf.length) {
      messages.push(buf.join("\n"));
      buf = [];
      len = 0;
    }
  };
  for (const line of lines) {
    const add = line.length + 1; // +1 на перенос строки
    if (len + add > limit && buf.length) flush();
    buf.push(line);
    len += add;
  }
  flush();
  return messages;
}

// Полный отчёт: заголовок с датой + секции бухгалтеров + ссылка на дашборд.
// Возвращает МАССИВ сообщений (одно или несколько), готовых к отправке.
export function buildTicketReport(accountants, { label, dashboardUrl } = {}) {
  const header = `📋 Отчёт по тикетам за ${label || ""}`.trim();

  if (!accountants || accountants.length === 0) {
    let msg = `${header}\n\nЗа вчера тикетов не было.`;
    if (dashboardUrl) msg += `\n\n${dashboardUrl}`;
    return [msg];
  }

  const lines = [header];
  for (const acc of accountants) {
    lines.push("");
    lines.push(...buildAccountantSection(acc));
  }
  if (dashboardUrl) {
    lines.push("");
    lines.push(dashboardUrl);
  }

  return splitIntoMessages(lines);
}
