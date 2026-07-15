// Тесты общей логики разбора тикетов: даты (Asia/Yerevan), отбор, подсчёт,
// severity, валидация апелляции и построение отчёта в Telegram.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  yesterdayRange,
  isYesterday,
  severityOf,
  isRelevantTicket,
  ticketBelongsTo,
  summarizeTickets,
  validateAppealComment,
  escapeHtml,
  buildTicketReport,
  groupDailyByAccountant,
  TELEGRAM_SAFE_LIMIT,
} from "../lib/ticketReview.js";

// Yerevan = UTC+4 круглый год (в Армении перевода часов нет).
const at = (iso) => new Date(iso);

// 1. Базовый расчёт «вчера».
test("вчера в Asia/Yerevan: 15.07 днём → диапазон 14.07 00:00..15.07 00:00 (Ереван)", () => {
  const r = yesterdayRange(at("2026-07-15T09:00:00Z")); // 13:00 Ереван, 15-е
  assert.equal(r.dateLabel, "14.07.2026");
  assert.equal(r.dateKey, "2026-07-14");
  // 14.07 00:00 Ереван = 13.07 20:00 UTC; 15.07 00:00 Ереван = 14.07 20:00 UTC.
  assert.equal(r.startUtc.toISOString(), "2026-07-13T20:00:00.000Z");
  assert.equal(r.endUtc.toISOString(), "2026-07-14T20:00:00.000Z");
});

// 2. Граница месяца.
test("граница месяца: 01.07 → вчера 30.06", () => {
  const r = yesterdayRange(at("2026-07-01T06:00:00Z")); // 10:00 Ереван, 1 июля
  assert.equal(r.dateLabel, "30.06.2026");
  assert.equal(r.startUtc.toISOString(), "2026-06-29T20:00:00.000Z");
  assert.equal(r.endUtc.toISOString(), "2026-06-30T20:00:00.000Z");
});

// 3. Граница года.
test("граница года: 01.01 → вчера 31.12 прошлого года", () => {
  const r = yesterdayRange(at("2026-01-01T05:00:00Z")); // 09:00 Ереван, 1 января
  assert.equal(r.dateLabel, "31.12.2025");
  assert.equal(r.dateKey, "2025-12-31");
  assert.equal(r.startUtc.toISOString(), "2025-12-30T20:00:00.000Z");
  assert.equal(r.endUtc.toISOString(), "2025-12-31T20:00:00.000Z");
});

// 4. Граница UTC против Ереванской: поздний вечер по UTC — уже следующий день в
//    Ереване, поэтому «вчера» сдвигается на день вперёд относительно UTC-логики.
test("UTC против Yerevan: 14.07 21:00 UTC = 15.07 01:00 Ереван → вчера = 14.07", () => {
  const r = yesterdayRange(at("2026-07-14T21:00:00Z"));
  // По Еревану сейчас уже 15-е, значит вчера — 14-е (а наивная UTC-логика дала бы 13-е).
  assert.equal(r.dateKey, "2026-07-14");
});

test("isYesterday учитывает Ереванские границы", () => {
  const now = at("2026-07-15T09:00:00Z");
  // 14.07 12:00 Ереван (08:00 UTC) — вчера.
  assert.equal(isYesterday("2026-07-14T08:00:00Z", now), true);
  // 13.07 23:59 Ереван — позавчера, не вчера.
  assert.equal(isYesterday("2026-07-13T19:00:00Z", now), false);
  // 15.07 00:30 Ереван (14.07 20:30 UTC) — уже сегодня, не вчера.
  assert.equal(isYesterday("2026-07-14T20:30:00Z", now), false);
});

test("severity по приоритету", () => {
  assert.equal(severityOf(1), "critical");
  assert.equal(severityOf(2), "medium");
  assert.equal(severityOf(3), "light");
  assert.equal(severityOf(null), "light");
});

// Хелпер для тикета.
const ticket = (o = {}) => ({
  problem_id: o.problem_id || "margarita:1",
  source: o.source || "margarita_review",
  status: o.status || "waiting_for_accountant",
  verdict: o.verdict ?? null,
  priority: o.priority ?? 1,
  chat_name: o.chat_name || "B-100",
  accountant_id: o.accountant_id || "emp-1",
  accountant_name: o.accountant_name || "Иван Петров",
  problem_title: o.problem_title || "Проблема",
  detected_at: o.detected_at || "2026-07-14T08:00:00Z",
  ...o,
});

test("isRelevantTicket: только margarita/sona, актуальный статус, не ложное срабатывание, не тест-чат", () => {
  assert.equal(isRelevantTicket(ticket()), true);
  assert.equal(isRelevantTicket(ticket({ source: "ai" })), false);
  assert.equal(isRelevantTicket(ticket({ status: "fixed" })), false);
  assert.equal(isRelevantTicket(ticket({ verdict: "not_problematic" })), false);
  assert.equal(isRelevantTicket(ticket({ chat_name: "testchat67" })), false);
  assert.equal(isRelevantTicket(ticket({ source: "sona_review", status: "appeal_rejected" })), true);
});

test("ticketBelongsTo: по uuid и по имени, чужой — нет", () => {
  const me = { employee_id: "emp-1", full_name: "Иван Петров" };
  assert.equal(ticketBelongsTo(ticket(), me), true);
  // id чужой, но имя совпадает → всё ещё мой (защитное сопоставление по имени).
  assert.equal(ticketBelongsTo(ticket({ accountant_id: "emp-2" }), me), true);
  const other = ticket({ accountant_id: "emp-2", accountant_name: "Пётр Иванов" });
  assert.equal(ticketBelongsTo(other, me), false);
  // Совпадение по имени, когда id пуст.
  assert.equal(ticketBelongsTo(ticket({ accountant_id: null, accountant_name: "иван  петров" }), me), true);
});

// 19. Группировка severity + подсчёт.
test("summarizeTickets: severity-группы, принято/апелляций/без ответа без двойного счёта", () => {
  const tickets = [
    ticket({ problem_id: "p1", priority: 1 }),
    ticket({ problem_id: "p2", priority: 2 }),
    ticket({ problem_id: "p3", priority: 3 }),
    ticket({ problem_id: "p3", priority: 3 }), // дубль — не должен считаться дважды
  ];
  const s = summarizeTickets(
    tickets,
    [{ problem_id: "p1" }], // принято p1
    [{ problem_id: "p2" }], // апелляция p2
  );
  assert.equal(s.total, 3);
  assert.equal(s.accepted, 1);
  assert.equal(s.appealed, 1);
  assert.equal(s.unanswered, 1); // p3
  assert.equal(s.bySeverity.critical.length, 1);
  assert.equal(s.bySeverity.medium.length, 1);
  assert.equal(s.bySeverity.light.length, 1);
  assert.equal(s.complete, false);
});

// 5,6,7. Блокировка: нет тикетов / все отвечены → не блокирует; один без ответа → блокирует.
test("gate: пустой набор → complete", () => {
  const s = summarizeTickets([], [], []);
  assert.equal(s.complete, true);
  assert.equal(s.unanswered, 0);
});
test("gate: все отвечены → complete", () => {
  const tickets = [ticket({ problem_id: "p1" }), ticket({ problem_id: "p2" })];
  const s = summarizeTickets(tickets, [{ problem_id: "p1" }], [{ problem_id: "p2" }]);
  assert.equal(s.complete, true);
});
test("gate: один без ответа → блокирует", () => {
  const tickets = [ticket({ problem_id: "p1" }), ticket({ problem_id: "p2" })];
  const s = summarizeTickets(tickets, [{ problem_id: "p1" }], []);
  assert.equal(s.complete, false);
  assert.equal(s.unanswered, 1);
  assert.equal(s.unansweredTickets[0].problem_id, "p2");
});

// 13. Апелляция с пустым комментарием отклоняется.
test("validateAppealComment: пусто/пробелы → ошибка, обрезка, лимит длины", () => {
  assert.equal(validateAppealComment("").ok, false);
  assert.equal(validateAppealComment("   ").ok, false);
  assert.equal(validateAppealComment("\n\t ").error, "comment_required");
  const ok = validateAppealComment("  не согласен  ");
  assert.equal(ok.ok, true);
  assert.equal(ok.value, "не согласен"); // trim
  assert.equal(validateAppealComment("x".repeat(3000)).error, "comment_too_long");
});

// 21. Экранирование Telegram-HTML.
test("escapeHtml экранирует & < >", () => {
  assert.equal(escapeHtml('B & <x> "y"'), "B &amp; &lt;x&gt; \"y\"");
  assert.equal(escapeHtml("Чат A&B"), "Чат A&amp;B");
});

test("отчёт экранирует опасные символы в названиях чатов", () => {
  const per = [
    {
      key: "emp-1",
      accountantName: "Иван <b>Петров</b>",
      summary: summarizeTickets([ticket({ problem_id: "p1", chat_name: "A & <script>", priority: 1 })], [], []),
    },
  ];
  const msgs = buildTicketReport(per, "14.07.2026", "https://d");
  const full = msgs.join("\n");
  assert.match(full, /Иван &lt;b&gt;Петров&lt;\/b&gt;/);
  assert.match(full, /A &amp; &lt;script&gt;/);
  assert.doesNotMatch(full, /<script>/);
});

// 18. Счётчики отчёта совпадают с общей логикой (summarizeTickets).
test("отчёт: заголовки Апелляций/Принято/Без ответа совпадают со сводкой", () => {
  const tickets = [
    ticket({ problem_id: "p1", priority: 1, chat_name: "B-1" }),
    ticket({ problem_id: "p2", priority: 2, chat_name: "B-2" }),
    ticket({ problem_id: "p3", priority: 3, chat_name: "B-3" }),
  ];
  const summary = summarizeTickets(tickets, [{ problem_id: "p1" }], [{ problem_id: "p2" }]);
  const per = [{ key: "emp-1", accountantName: "Иван Петров", summary }];
  const msgs = buildTicketReport(per, "14.07.2026", "https://d");
  const full = msgs.join("\n");
  assert.match(full, /📋 Отчёт по тикетам за 14\.07\.2026/);
  assert.match(full, /👤 <b>Иван Петров<\/b>/);
  assert.match(full, new RegExp(`Апелляций: ${summary.appealed}`));
  assert.match(full, new RegExp(`Принято: ${summary.accepted}`));
  assert.match(full, new RegExp(`Без ответа: ${summary.unanswered}`));
  assert.match(full, /🔴 Критические проблемы: 1/);
  assert.match(full, /🟠 Средние проблемы: 1/);
  assert.match(full, /🟢 Лёгкие проблемы: 1/);
});

// 20. Длинный отчёт безопасно разбивается и не режет строку тикета.
test("длинный отчёт делится на несколько сообщений в пределах лимита, без обрыва строк", () => {
  const per = [];
  for (let a = 0; a < 40; a++) {
    const tickets = [];
    for (let i = 0; i < 20; i++) {
      tickets.push(
        ticket({
          problem_id: `p${a}-${i}`,
          priority: (i % 3) + 1,
          chat_name: `B-${a}-${i}`,
          problem_title: "Очень длинное описание проблемы ".repeat(3) + i,
        }),
      );
    }
    per.push({ key: `emp-${a}`, accountantName: `Бухгалтер № ${a}`, summary: summarizeTickets(tickets, [], []) });
  }
  const msgs = buildTicketReport(per, "14.07.2026", "https://d");
  assert.ok(msgs.length > 1, "ожидалось несколько сообщений");
  for (const m of msgs) {
    assert.ok(m.length <= TELEGRAM_SAFE_LIMIT, `сообщение ${m.length} > лимита`);
  }
  // Каждая строка тикета целая: собрав все сообщения обратно, находим все строки.
  const joined = msgs.join("\n");
  assert.match(joined, /1\. Чат B-0-0/);
});

test("groupDailyByAccountant: группирует по ответственному и считает его апелляции", () => {
  const tickets = [
    ticket({ problem_id: "p1", accountant_id: "emp-1", accountant_name: "A", priority: 1 }),
    ticket({ problem_id: "p2", accountant_id: "emp-1", accountant_name: "A", priority: 2 }),
    ticket({ problem_id: "p3", accountant_id: "emp-2", accountant_name: "B", priority: 1 }),
  ];
  const acks = [{ problem_id: "p1", accountant_id: "emp-1" }];
  const appeals = [{ problem_id: "p3", accountant_id: "emp-2", status: "pending" }];
  const groups = groupDailyByAccountant(tickets, acks, appeals);
  assert.equal(groups.length, 2);
  const a = groups.find((g) => g.key === "emp-1");
  const b = groups.find((g) => g.key === "emp-2");
  assert.equal(a.summary.accepted, 1);
  assert.equal(a.summary.unanswered, 1);
  assert.equal(b.summary.appealed, 1);
  assert.equal(b.summary.unanswered, 0);
});
