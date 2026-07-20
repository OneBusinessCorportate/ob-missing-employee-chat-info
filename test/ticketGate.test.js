// Интеграционные тесты серверной блокировки (gate) поверх реального Express-
// приложения + проверки записи на уровне приложения. Supabase подменён фейковым
// клиентом (сеть не трогаем).
import { test } from "node:test";
import assert from "node:assert/strict";

// Включаем общий пароль, чтобы requireAuth реально требовал сессию (личность в
// подписанной cookie). Env — до импорта модулей.
process.env.ACCESS_PASSWORD = "test-pass";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key"; // чтобы getProblemChats не падал на этапе конфигурации

const { app } = await import("../server.js");
const { signIdentity } = await import("../lib/auth.js");
const { __setServiceClientForTests } = await import("../lib/supabaseServer.js");
const { yesterdayRange, acceptTicket, appealTicket } = await import("../lib/ticketReview.js");

// Момент «внутри вчера» и «вне вчера» относительно реального сейчас.
const range = yesterdayRange(new Date());
const YESTERDAY_TS = new Date(range.startUtc.getTime() + 12 * 3600 * 1000).toISOString();
const TODAY_TS = new Date(range.endUtc.getTime() + 3600 * 1000).toISOString();

// --- Фейковый клиент Supabase (чейнится и awaitable) ---------------------
function makeFakeClient(tables) {
  return {
    from(name) {
      const filters = [];
      let single = false;
      const b = {
        select() { return b; },
        order() { return b; },
        range() { return b; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return b; },
        eq(col, val) { filters.push((r) => String(r[col]) === String(val)); return b; },
        gte(col, val) { filters.push((r) => new Date(r[col]).getTime() >= new Date(val).getTime()); return b; },
        lt(col, val) { filters.push((r) => new Date(r[col]).getTime() < new Date(val).getTime()); return b; },
        maybeSingle() { single = true; return b; },
        then(resolve) {
          const rows = (tables[name] || []).filter((r) => filters.every((f) => f(r)));
          resolve({ data: single ? rows[0] ?? null : rows, error: null });
        },
      };
      return b;
    },
    // Симуляция kk_ticket_answer: контракт как у SQL-функции (для app-тестов).
    rpc(_name, args) {
      const problems = tables.kk_problems || [];
      const acks = (tables.kk_problem_acknowledgements ||= []);
      const appeals = (tables.kk_problem_appeals ||= []);
      const p = problems.find((x) => x.problem_id === args.p_problem_id);
      if (!p) return Promise.resolve({ data: { ok: false, error: "not_found" }, error: null });
      const hasAck = acks.some((a) => a.problem_id === args.p_problem_id);
      const hasAppeal = appeals.some((a) => a.problem_id === args.p_problem_id && a.accountant_id === args.p_accountant_id);
      if (args.p_action === "accept") {
        if (hasAppeal) return Promise.resolve({ data: { ok: false, error: "already_appealed" }, error: null });
        if (hasAck) return Promise.resolve({ data: { ok: true, status: "accepted", duplicate: true }, error: null });
        acks.push({ problem_id: args.p_problem_id, accountant_id: args.p_accountant_id });
        return Promise.resolve({ data: { ok: true, status: "accepted" }, error: null });
      }
      if (!args.p_comment || !args.p_comment.trim()) return Promise.resolve({ data: { ok: false, error: "comment_required" }, error: null });
      if (hasAck) return Promise.resolve({ data: { ok: false, error: "already_accepted" }, error: null });
      if (hasAppeal) return Promise.resolve({ data: { ok: true, status: "appealed", duplicate: true }, error: null });
      appeals.push({ problem_id: args.p_problem_id, accountant_id: args.p_accountant_id, status: "pending" });
      return Promise.resolve({ data: { ok: true, status: "appealed" }, error: null });
    },
  };
}

const ACC = { employee_id: "emp-1", full_name: "Иван Петров", role: "accountant", can_see_all: false };

const cookieFor = (identity) => `ob_session=${encodeURIComponent(signIdentity(identity))}`;

const mkTicket = (o) => ({
  problem_id: o.problem_id,
  source: "margarita_review",
  status: "waiting_for_accountant",
  verdict: null,
  priority: 1,
  chat_name: o.chat_name || "B-100",
  contract_id: "B-100",
  accountant_id: o.accountant_id || "emp-1",
  accountant_name: o.accountant_name || "Иван Петров",
  problem_title: "Проблема",
  problem_description: "Описание",
  detected_at: o.detected_at || YESTERDAY_TS,
});

// Запускаем приложение на эфемерном порту, выполняем запрос, гасим сервер.
async function withServer(tables, fn) {
  __setServiceClientForTests(makeFakeClient(tables));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const call = (path, { cookie, method = "GET", body } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// Дашборд открыт для всех: даже у бухгалтера с необработанными вчерашними
// тикетами страница и API проблемных чатов доступны (блокировки просмотра нет).
// Страница разбора и её API продолжают работать для вошедшего бухгалтера.
test("дашборд открыт даже при необработанных тикетах; разбор доступен вошедшему", async () => {
  const tables = { kk_problems: [mkTicket({ problem_id: "p1" })], kk_problem_acknowledgements: [], kk_problem_appeals: [], v_chat_missing_responsibles: [] };
  await withServer(tables, async (call) => {
    const home = await call("/", { cookie: cookieFor(ACC) });
    assert.equal(home.status, 200);

    const api = await call("/api/problem-chats", { cookie: cookieFor(ACC) });
    assert.equal(api.status, 200);
    const j = await api.json();
    assert.equal(j.ok, true);

    // Страница разбора и её API остаются доступны вошедшему бухгалтеру.
    const review = await call("/review-tickets", { cookie: cookieFor(ACC) });
    assert.equal(review.status, 200);
    const list = await call("/api/review/tickets", { cookie: cookieFor(ACC) });
    assert.equal(list.status, 200);
    const lj = await list.json();
    assert.equal(lj.tickets.length, 1);
    assert.equal(lj.progress.remaining, 1);
    assert.equal(lj.progress.complete, false);
  });
});

// Дашборд открыт без сессии (без входа/пароля); API проблемных чатов тоже открыт.
// Персональный API разбора по-прежнему требует вход.
test("без сессии: дашборд и API проблемных чатов открыты; API разбора требует вход", async () => {
  await withServer({ kk_problems: [], v_chat_missing_responsibles: [] }, async (call) => {
    const home = await call("/");
    assert.equal(home.status, 200);
    const api = await call("/api/problem-chats");
    assert.equal(api.status, 200);
    const j = await api.json();
    assert.equal(j.ok, true);

    // Разбор тикетов — персональный, всё ещё под входом.
    const review = await call("/api/review/tickets");
    assert.equal(review.status, 401);
  });
});

// --- Проверки записи на уровне приложения (ownership / окно / комментарий) ---

// 11. Согласие по своему актуальному вчерашнему тикету — успех.
test("acceptTicket: свой вчерашний тикет → ok accepted", async () => {
  const tables = { kk_problems: [mkTicket({ problem_id: "p1" })], kk_problem_acknowledgements: [], kk_problem_appeals: [] };
  const client = makeFakeClient(tables);
  const res = await acceptTicket("p1", ACC, { client });
  assert.equal(res.ok, true);
  assert.equal(res.status, "accepted");
});

// 12. Апелляция с валидным комментарием — успех.
test("appealTicket: валидный комментарий → ok appealed", async () => {
  const tables = { kk_problems: [mkTicket({ problem_id: "p1" })], kk_problem_acknowledgements: [], kk_problem_appeals: [] };
  const client = makeFakeClient(tables);
  const res = await appealTicket("p1", ACC, { comment: "не согласен, клиент ответил", client });
  assert.equal(res.ok, true);
  assert.equal(res.status, "appealed");
});

// 13. Апелляция с пустым комментарием — отклонена ещё до БД.
test("appealTicket: пустой комментарий → comment_required", async () => {
  const tables = { kk_problems: [mkTicket({ problem_id: "p1" })] };
  const client = makeFakeClient(tables);
  const res = await appealTicket("p1", ACC, { comment: "   ", client });
  assert.equal(res.ok, false);
  assert.equal(res.error, "comment_required");
});

// 14. Дубликат согласия — идемпотентно.
test("acceptTicket дважды → второй раз duplicate", async () => {
  const tables = { kk_problems: [mkTicket({ problem_id: "p1" })], kk_problem_acknowledgements: [], kk_problem_appeals: [] };
  const client = makeFakeClient(tables);
  await acceptTicket("p1", ACC, { client });
  const res2 = await acceptTicket("p1", ACC, { client });
  assert.equal(res2.ok, true);
  assert.equal(res2.duplicate, true);
});

// 14b. Противоречие: принятый тикет нельзя обжаловать.
test("нельзя обжаловать уже принятый тикет", async () => {
  const tables = { kk_problems: [mkTicket({ problem_id: "p1" })], kk_problem_acknowledgements: [], kk_problem_appeals: [] };
  const client = makeFakeClient(tables);
  await acceptTicket("p1", ACC, { client });
  const res = await appealTicket("p1", ACC, { comment: "передумал", client });
  assert.equal(res.ok, false);
  assert.equal(res.error, "already_accepted");
});

// 15. Нельзя ответить за чужой тикет.
test("acceptTicket: чужой тикет → forbidden", async () => {
  const tables = { kk_problems: [mkTicket({ problem_id: "p1", accountant_id: "emp-2", accountant_name: "Другой" })] };
  const client = makeFakeClient(tables);
  const res = await acceptTicket("p1", ACC, { client });
  assert.equal(res.ok, false);
  assert.equal(res.error, "forbidden");
});

// Окно: сегодняшний тикет нельзя обработать через API разбора (вне окна вчера).
test("acceptTicket: сегодняшний тикет → not_in_review_window", async () => {
  const tables = { kk_problems: [mkTicket({ problem_id: "pt", detected_at: TODAY_TS })] };
  const client = makeFakeClient(tables);
  const res = await acceptTicket("pt", ACC, { client });
  assert.equal(res.ok, false);
  assert.equal(res.error, "not_in_review_window");
});
