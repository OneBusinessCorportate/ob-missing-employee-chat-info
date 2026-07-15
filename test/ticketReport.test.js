// Тесты ежедневного отчёта по тикетам: счётчики (совпадают с общей логикой),
// группировка по серьёзности, безопасная разбивка длинных сообщений,
// экранирование форматирования.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReport, previousDayRange } from "../lib/ticketReview.js";
import {
  buildTicketReport,
  buildAccountantSection,
  splitIntoMessages,
  escapeMarkdownV2,
  sanitizeLine,
} from "../lib/ticketReport.js";

const NOW = new Date("2026-07-15T10:00:00Z");
const RANGE = previousDayRange(NOW);

function ticket(over = {}) {
  return {
    problem_id: over.problem_id || Math.random().toString(36).slice(2),
    accountant_id: over.accountant_id ?? "emp-1",
    accountant_name: over.accountant_name ?? "Имя Бухгалтера",
    chat_name: over.chat_name ?? "ООО Клиент B-3245 RU",
    problem_title: over.problem_title ?? "не ответил клиенту",
    priority: over.priority ?? 2,
    status: over.status ?? "waiting_for_accountant",
    detected_at: over.detected_at ?? "2026-07-14T09:00:00Z",
    ...over,
  };
}

test("18. счётчики отчёта совпадают с общей логикой (accepted/appealed/unanswered)", () => {
  const problems = [
    ticket({ problem_id: "a", priority: 1 }),
    ticket({ problem_id: "b", priority: 2 }),
    ticket({ problem_id: "c", priority: 3 }),
    ticket({ problem_id: "d", priority: 2 }),
  ];
  const acknowledgedIds = new Set(["a", "b"]); // 2 принято
  const appealedIds = new Set(["c"]); // 1 апелляция
  const report = computeReport(problems, { range: RANGE, acknowledgedIds, appealedIds });
  assert.equal(report.length, 1);
  const acc = report[0];
  assert.equal(acc.accepted, 2);
  assert.equal(acc.appealed, 1);
  assert.equal(acc.unanswered, 1); // d
  assert.equal(acc.total, 4);

  const section = buildAccountantSection(acc).join("\n");
  assert.match(section, /Апелляций: 1/);
  assert.match(section, /Принято: 2/);
  assert.match(section, /Без ответа: 1/);
});

test("19. группировка по серьёзности верна (1→крит, 2→сред, 3→лёгк)", () => {
  const problems = [
    ticket({ problem_id: "k1", priority: 1, chat_name: "B-3245", problem_title: "не ответил клиенту" }),
    ticket({ problem_id: "k2", priority: 1, chat_name: "B-1180" }),
    ticket({ problem_id: "m1", priority: 2, chat_name: "B-4482" }),
    ticket({ problem_id: "l1", priority: 3, chat_name: "B-1001" }),
    ticket({ problem_id: "l2", priority: 3, chat_name: "B-2390" }),
    ticket({ problem_id: "l3", priority: 3, chat_name: "B-3022" }),
  ];
  const report = computeReport(problems, { range: RANGE });
  const acc = report[0];
  assert.equal(acc.severities.critical.length, 2);
  assert.equal(acc.severities.medium.length, 1);
  assert.equal(acc.severities.light.length, 3);

  const section = buildAccountantSection(acc).join("\n");
  assert.match(section, /🔴 Критические проблемы: 2/);
  assert.match(section, /🟠 Средние проблемы: 1/);
  assert.match(section, /🟢 Лёгкие проблемы: 3/);
  assert.match(section, /1\. Чат B-3245 — не ответил клиенту/);
});

test("несколько бухгалтеров — по секции на каждого, заголовок с датой", () => {
  const problems = [
    ticket({ problem_id: "x", accountant_name: "Анна", accountant_id: "e1" }),
    ticket({ problem_id: "y", accountant_name: "Борис", accountant_id: "e2" }),
  ];
  const report = computeReport(problems, { range: RANGE });
  const msgs = buildTicketReport(report, { label: RANGE.label, dashboardUrl: "https://dash" });
  const all = msgs.join("\n");
  assert.match(all, /📋 Отчёт по тикетам за 14\.07\.2026/);
  assert.match(all, /👤 Анна/);
  assert.match(all, /👤 Борис/);
  assert.match(all, /https:\/\/dash/);
});

test("нет вчерашних тикетов — одно короткое сообщение", () => {
  const msgs = buildTicketReport([], { label: RANGE.label });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /За вчера тикетов не было/);
});

test("20. длинный отчёт делится безопасно (без разрезания строк тикета)", () => {
  // Строим много строк, заведомо превышающих лимит.
  const lines = [];
  for (let i = 0; i < 400; i++) {
    lines.push(`${i + 1}. Чат B-${1000 + i} — довольно длинное описание проблемы для объёма сообщения`);
  }
  const limit = 1000;
  const msgs = splitIntoMessages(lines, limit);
  assert.ok(msgs.length > 1, "ожидали несколько сообщений");
  for (const m of msgs) assert.ok(m.length <= limit, `сообщение превышает лимит: ${m.length}`);
  // Ни одна строка не потеряна и не разрезана: обратная сборка совпадает.
  assert.deepEqual(msgs.join("\n").split("\n"), lines);
});

test("21. экранирование Telegram-форматирования и очистка строк", () => {
  assert.equal(escapeMarkdownV2("a_b*c[d]"), "a\\_b\\*c\\[d\\]");
  assert.equal(escapeMarkdownV2("1.2-3"), "1\\.2\\-3");
  // sanitizeLine убирает переносы/управляющие символы и схлопывает пробелы.
  assert.equal(sanitizeLine("строка\nс   переносом\tи табом"), "строка с переносом и табом");
  // Многострочный текст проблемы не ломает построчную вёрстку.
  const acc = {
    accountant_name: "Имя\nМногострочное",
    accepted: 0,
    appealed: 0,
    unanswered: 1,
    severities: { critical: [{ chat_code: "B-1", text: "строка\nтекст" }], medium: [], light: [] },
  };
  const section = buildAccountantSection(acc);
  for (const line of section) assert.ok(!line.includes("\n"), "строка секции не должна содержать перенос");
});
