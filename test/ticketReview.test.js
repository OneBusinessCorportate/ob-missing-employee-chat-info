// Юнит-тесты общей логики обязательного разбора вчерашних тикетов.
// Чистые функции (без Supabase): дата «вчера» в Asia/Yerevan, отбор тикетов,
// расчёт гейта, валидация ответа, решение гейта.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  previousDayRange,
  computeAccountantGate,
  validateAnswer,
  gateDecision,
  isGateExempt,
} from "../lib/ticketReview.js";

const iso = (d) => d.toISOString();

// --- previousDayRange (Asia/Yerevan, UTC+4) --------------------------------

test("1. «вчера» в Asia/Yerevan для обычного дня", () => {
  const r = previousDayRange(new Date("2026-07-15T10:00:00Z"));
  assert.equal(r.ymd, "2026-07-14");
  assert.equal(r.label, "14.07.2026");
  // Полночь 14.07 в Ереване = 13.07 20:00 UTC; конец = 14.07 20:00 UTC.
  assert.equal(iso(r.startUtc), "2026-07-13T20:00:00.000Z");
  assert.equal(iso(r.endUtc), "2026-07-14T20:00:00.000Z");
});

test("2. граница месяца", () => {
  const r = previousDayRange(new Date("2026-08-01T02:00:00Z")); // Ереван 06:00 01.08
  assert.equal(r.ymd, "2026-07-31");
  assert.equal(r.label, "31.07.2026");
  assert.equal(iso(r.startUtc), "2026-07-30T20:00:00.000Z");
  assert.equal(iso(r.endUtc), "2026-07-31T20:00:00.000Z");
});

test("3. граница года", () => {
  const r = previousDayRange(new Date("2026-01-01T05:00:00Z")); // Ереван 09:00 01.01.2026
  assert.equal(r.ymd, "2025-12-31");
  assert.equal(r.label, "31.12.2025");
  assert.equal(iso(r.endUtc), "2025-12-31T20:00:00.000Z");
});

test("4. граница суток UTC vs Ереван", () => {
  // 21:00 UTC 15.07 = 01:00 16.07 в Ереване → «сегодня» 16.07, «вчера» 15.07.
  const late = previousDayRange(new Date("2026-07-15T21:00:00Z"));
  assert.equal(late.ymd, "2026-07-15");
  assert.equal(late.label, "15.07.2026");
  // Тот же момент по UTC-логике дал бы «вчера» = 14.07 — показываем расхождение.
  const early = previousDayRange(new Date("2026-07-15T02:00:00Z")); // Ереван 06:00 15.07
  assert.equal(early.ymd, "2026-07-14");
});

// --- computeAccountantGate --------------------------------------------------

const NOW = new Date("2026-07-15T10:00:00Z");
const RANGE = previousDayRange(NOW);
const EMP = "emp-1";

function ticket(over = {}) {
  return {
    problem_id: over.problem_id || Math.random().toString(36).slice(2),
    accountant_id: over.accountant_id ?? EMP,
    accountant_name: over.accountant_name ?? "Тест Бухгалтер",
    chat_name: over.chat_name ?? "ООО Клиент B-1234 RU",
    priority: over.priority ?? 2,
    status: over.status ?? "waiting_for_accountant",
    detected_at: over.detected_at ?? "2026-07-14T09:00:00Z", // вчера (в диапазоне)
    ...over,
  };
}

const gateOf = (problems, opts = {}) =>
  computeAccountantGate(problems, { employeeId: EMP, range: RANGE, ...opts });

test("5. нет вчерашних тикетов — не блокируется", () => {
  const g = gateOf([]);
  assert.equal(g.unanswered, 0);
  assert.equal(g.done, true);
});

test("6. все вчерашние тикеты отвечены — не блокируется", () => {
  const t1 = ticket({ problem_id: "p1" });
  const t2 = ticket({ problem_id: "p2" });
  const g = gateOf([t1, t2], {
    acknowledgedIds: new Set(["p1"]),
    appealedIds: new Set(["p2"]),
  });
  assert.equal(g.total, 2);
  assert.equal(g.accepted, 1);
  assert.equal(g.appealed, 1);
  assert.equal(g.unanswered, 0);
  assert.equal(g.done, true);
});

test("7. один необработанный вчерашний тикет — блокируется", () => {
  const g = gateOf([ticket({ problem_id: "p1" }), ticket({ problem_id: "p2" })], {
    acknowledgedIds: new Set(["p1"]),
  });
  assert.equal(g.unanswered, 1);
  assert.equal(g.done, false);
  assert.equal(g.tickets[0].problem_id, "p2");
});

test("8. сегодняшние тикеты не блокируют", () => {
  const today = ticket({ problem_id: "t", detected_at: "2026-07-15T09:00:00Z" });
  const g = gateOf([today]);
  assert.equal(g.total, 0);
  assert.equal(g.done, true);
});

test("9. тикеты другого бухгалтера не блокируют", () => {
  const other = ticket({ problem_id: "o", accountant_id: "emp-2" });
  const g = gateOf([other]);
  assert.equal(g.total, 0);
  assert.equal(g.done, true);
});

test("10. более старые тикеты не блокируют", () => {
  const old = ticket({ problem_id: "old", detected_at: "2026-07-10T09:00:00Z" });
  const g = gateOf([old]);
  assert.equal(g.total, 0);
  assert.equal(g.done, true);
});

test("неактивные (auto_resolved) и тестовые чаты не блокируют", () => {
  const resolved = ticket({ problem_id: "r", status: "auto_resolved" });
  const testChat = ticket({ problem_id: "tc", chat_name: "testchat67" });
  const g = gateOf([resolved, testChat]);
  assert.equal(g.total, 0);
  assert.equal(g.done, true);
});

// --- validateAnswer ---------------------------------------------------------

const okTicket = ticket({ problem_id: "v1" });

test("11. принятие проходит валидацию", () => {
  const v = validateAnswer({ action: "accept", ticket: okTicket, employeeId: EMP, range: RANGE });
  assert.equal(v.ok, true);
});

test("12. апелляция с валидным комментарием проходит (комментарий обрезается)", () => {
  const v = validateAnswer({
    action: "appeal",
    ticket: okTicket,
    employeeId: EMP,
    comment: "  не согласен: клиент не писал  ",
    range: RANGE,
  });
  assert.equal(v.ok, true);
  assert.equal(v.comment, "не согласен: клиент не писал");
});

test("13. апелляция с пустым комментарием отклоняется", () => {
  const v = validateAnswer({ action: "appeal", ticket: okTicket, employeeId: EMP, comment: "   ", range: RANGE });
  assert.equal(v.ok, false);
  assert.equal(v.code, "COMMENT_REQUIRED");
});

test("15. нельзя ответить за чужой тикет", () => {
  const foreign = ticket({ problem_id: "f", accountant_id: "emp-2" });
  const v = validateAnswer({ action: "accept", ticket: foreign, employeeId: EMP, range: RANGE });
  assert.equal(v.ok, false);
  assert.equal(v.code, "NOT_OWNER");
});

test("валидация: неактуальный статус и вне диапазона отклоняются", () => {
  const resolved = ticket({ status: "auto_resolved" });
  assert.equal(validateAnswer({ action: "accept", ticket: resolved, employeeId: EMP, range: RANGE }).code, "NOT_ELIGIBLE");
  const today = ticket({ detected_at: "2026-07-15T09:00:00Z" });
  assert.equal(validateAnswer({ action: "accept", ticket: today, employeeId: EMP, range: RANGE }).code, "OUT_OF_RANGE");
});

// --- gateDecision (серверное принуждение) -----------------------------------

test("16. защищённый путь блокируется при необработанных; разрешённые пути — нет", () => {
  const s = { emp: EMP, adm: false };
  assert.equal(gateDecision({ session: s, unanswered: 1, path: "/" }).blocked, true);
  assert.equal(gateDecision({ session: s, unanswered: 1, path: "/api/problem-chats" }).blocked, true);
  // Разбор и служебные пути остаются доступны (иначе редирект-петля).
  assert.equal(gateDecision({ session: s, unanswered: 1, path: "/review" }).blocked, false);
  assert.equal(gateDecision({ session: s, unanswered: 1, path: "/api/review/tickets" }).blocked, false);
  assert.equal(gateDecision({ session: s, unanswered: 1, path: "/logout" }).blocked, false);
  assert.equal(gateDecision({ session: s, unanswered: 1, path: "/healthz" }).blocked, false);
  assert.ok(isGateExempt("/api/review/accept"));
  assert.ok(!isGateExempt("/"));
  // После обработки всех — доступ открыт.
  assert.equal(gateDecision({ session: s, unanswered: 0, path: "/" }).blocked, false);
});

test("17. админ (can_see_all) не блокируется", () => {
  const admin = { adm: true, name: "admin" };
  assert.equal(gateDecision({ session: admin, unanswered: 5, path: "/" }).blocked, false);
  // Нет сессии — гейт не решает (этим занимается requireAuth).
  assert.equal(gateDecision({ session: null, unanswered: 5, path: "/" }).blocked, false);
});
