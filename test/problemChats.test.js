// Юнит-тесты движка расчёта проблемных чатов (node:test, без Supabase).
// Вход соответствует строкам вью v_chat_missing_responsibles:
//   { chat_id, chat_name, has_accountant, has_head_accountant, has_manager }.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeProblems, isTestChat } from "../lib/problemChats.js";

// Хелпер: acc/head/mgr — булевы флаги НАЛИЧИЯ ответственного (true = есть).
// checked по умолчанию true (чат реально проверялся).
function chat(name, { acc = false, head = false, mgr = false, checked = true, ...rest } = {}) {
  return {
    chat_id: rest.chat_id ?? name,
    chat_name: name,
    has_accountant: acc,
    has_head_accountant: head,
    has_manager: mgr,
    checked,
    ...rest,
  };
}

test("все роли на месте — чат не проблемный", () => {
  const { problems, counts } = computeProblems([
    chat("ok", { acc: true, head: true, mgr: true }),
  ]);
  assert.equal(problems.length, 0);
  assert.equal(counts.total_problems, 0);
  assert.equal(counts.total_chats, 1);
});

test("нет бухгалтера", () => {
  const { problems, counts } = computeProblems([
    chat("c", { acc: false, head: true, mgr: true }),
  ]);
  assert.equal(counts.total_problems, 1);
  assert.equal(counts.missing_accountant, 1);
  assert.equal(counts.missing_head_accountant, 0);
  assert.equal(counts.missing_manager, 0);
  assert.equal(problems[0].missing_accountant, true);
  assert.equal(problems[0].missing_count, 1);
});

test("нет главного бухгалтера", () => {
  const { counts } = computeProblems([chat("c", { acc: true, head: false, mgr: true })]);
  assert.equal(counts.missing_head_accountant, 1);
  assert.equal(counts.total_problems, 1);
});

test("нет менеджера", () => {
  const { counts } = computeProblems([chat("c", { acc: true, head: true, mgr: false })]);
  assert.equal(counts.missing_manager, 1);
  assert.equal(counts.total_problems, 1);
});

test("не хватает нескольких ролей — один раз в total, но в каждой роли", () => {
  const { problems, counts } = computeProblems([chat("c", { acc: false, head: false, mgr: true })]);
  assert.equal(counts.total_problems, 1);
  assert.equal(counts.missing_accountant, 1);
  assert.equal(counts.missing_head_accountant, 1);
  assert.equal(counts.missing_manager, 0);
  assert.equal(problems[0].missing_count, 2);
});

test("совсем нет ответственных — не хватает всех трёх", () => {
  const { problems, counts } = computeProblems([{ chat_id: -5009453463, chat_name: "B-4164" }]);
  assert.equal(counts.total_problems, 1);
  assert.equal(counts.missing_accountant, 1);
  assert.equal(counts.missing_head_accountant, 1);
  assert.equal(counts.missing_manager, 1);
  assert.equal(problems[0].missing_count, 3);
  assert.equal(problems[0].chat_id, "-5009453463"); // приводится к строке
});

test("chat_id приводится к строке", () => {
  const { problems } = computeProblems([chat("x", { chat_id: -1002954615886 })]);
  assert.equal(problems[0].chat_id, "-1002954615886");
});

test("дубликаты названий помечаются ambiguous", () => {
  const { problems } = computeProblems([
    chat("dup", { acc: false, chat_id: 1 }),
    chat("dup", { acc: false, chat_id: 2 }),
    chat("uniq", { acc: false, chat_id: 3 }),
  ]);
  const byId = Object.fromEntries(problems.map((p) => [p.chat_id, p]));
  assert.equal(byId["1"].ambiguous, true);
  assert.equal(byId["2"].ambiguous, true);
  assert.equal(byId["3"].ambiguous, false);
});

test("data_updated_at — максимальный checked_at среди всех чатов", () => {
  const { counts } = computeProblems([
    chat("a", { checked_at: "2026-07-01T00:00:00Z" }),
    chat("b", { acc: true, head: true, mgr: true, checked_at: "2026-07-07T00:00:00Z" }),
  ]);
  assert.equal(counts.data_updated_at, "2026-07-07T00:00:00Z");
});

test("пустой ввод не падает", () => {
  const empty = computeProblems([]);
  assert.equal(empty.counts.total_problems, 0);
  assert.equal(empty.counts.total_chats, 0);
  assert.equal(computeProblems(null).counts.total_chats, 0);
});

// --- Исключение тестовых чатов ---
test("isTestChat распознаёт тестовые чаты по имени", () => {
  assert.equal(isTestChat({ chat_name: "testchat67" }), true);
  assert.equal(isTestChat({ chat_name: "TestChat" }), true);
  assert.equal(isTestChat({ chat_name: "  test blah" }), true);
  assert.equal(isTestChat({ chat_name: "ООО Ромашка" }), false);
  assert.equal(isTestChat({ chat_name: "" }), false);
  assert.equal(isTestChat({}), false);
});

test("по умолчанию тестовые чаты исключаются из списка и счётчиков", () => {
  const rows = [
    chat("testchat67", { acc: false, head: false, mgr: false }),
    chat("testchatAaa", { acc: false, head: false, mgr: false }),
    chat("ООО Ромашка", { acc: false, head: true, mgr: true }),
  ];
  const { problems, counts } = computeProblems(rows);
  assert.equal(counts.total_chats, 1);
  assert.equal(counts.excluded_test, 2);
  assert.equal(counts.total_problems, 1);
  assert.ok(problems.every((p) => !/^test/i.test(p.chat_name)));
});

test("свой шаблон исключения через опции", () => {
  const rows = [chat("qa-demo", { acc: false }), chat("ООО Клиент", { acc: false })];
  const { counts } = computeProblems(rows, { testPattern: /^qa-/i });
  assert.equal(counts.excluded_test, 1);
  assert.equal(counts.total_chats, 1);
});

// --- Непроверенные чаты (нет данных) ---
test("непроверенный чат не считается проблемным, попадает в notChecked", () => {
  const rows = [
    chat("B-4722", { checked: false }), // нет данных
    chat("реальный", { acc: false, head: true, mgr: true }), // проблема: нет бух
  ];
  const { problems, notChecked, counts } = computeProblems(rows);
  assert.equal(counts.total_chats, 1); // проверен только один
  assert.equal(counts.not_checked, 1);
  assert.equal(counts.total_problems, 1);
  assert.equal(notChecked.length, 1);
  assert.equal(notChecked[0].chat_name, "B-4722");
  assert.equal(notChecked[0].no_data, true);
  assert.ok(problems.every((p) => p.checked === true));
});

test("непроверенный чат без ответственных НЕ раздувает счётчики ролей", () => {
  const rows = [chat("нет данных", { acc: false, head: false, mgr: false, checked: false })];
  const { counts } = computeProblems(rows);
  assert.equal(counts.total_problems, 0);
  assert.equal(counts.missing_accountant, 0);
  assert.equal(counts.missing_head_accountant, 0);
  assert.equal(counts.missing_manager, 0);
  assert.equal(counts.not_checked, 1);
});

test("checked отсутствует в строке — считается проверенным (обратная совместимость)", () => {
  const { counts } = computeProblems([{ chat_id: 1, chat_name: "x" }]);
  assert.equal(counts.total_chats, 1);
  assert.equal(counts.not_checked, 0);
  assert.equal(counts.total_problems, 1);
});

// --- Ручные оверрайды: не требуется роль / роль подтверждена вручную ---
test("роль с оверрайдом not_required (req_*=false) не считается пропуском", () => {
  // Нет бухгалтера по сигналу, но роль для чата не требуется -> не проблема.
  const { problems, counts } = computeProblems([
    chat("клиент без бухгалтерии", { acc: false, head: true, mgr: true, req_accountant: false }),
  ]);
  assert.equal(counts.total_problems, 0);
  assert.equal(counts.missing_accountant, 0);
  assert.equal(problems.length, 0);
});

test("оверрайд not_required снимает только свою роль, остальные пропуски видны", () => {
  const { problems, counts } = computeProblems([
    chat("c", { acc: false, head: false, mgr: true, req_accountant: false }),
  ]);
  assert.equal(counts.total_problems, 1);
  assert.equal(counts.missing_accountant, 0); // роль не требуется
  assert.equal(counts.missing_head_accountant, 1); // всё ещё пропуск
  assert.equal(problems[0].missing_count, 1);
});

test("has_* от оверрайда present закрывает роль (missing=false)", () => {
  // Вью выставляет has_accountant=true при status='present'; здесь эмулируем.
  const { counts } = computeProblems([
    chat("ответственный отмечен вручную", { acc: true, head: true, mgr: true }),
  ]);
  assert.equal(counts.total_problems, 0);
});

test("req_* по умолчанию true — старые вью без оверрайдов работают как раньше", () => {
  const { counts } = computeProblems([{ chat_id: 1, chat_name: "x", has_head_accountant: true, has_manager: true }]);
  assert.equal(counts.missing_accountant, 1); // req_accountant не пришёл => требуется
  assert.equal(counts.total_problems, 1);
});

// Регрессия: воспроизводим точные вердикты из реального отчёта (по флагам вью).
test("вердикты как в реальном отчёте", () => {
  const rows = [
    // B-4148: есть бухгалтер, нет гл.бух и менеджера
    chat("B-4148", { chat_id: -5093324084, acc: true, head: false, mgr: false }),
    // B-4164: нет никого
    chat("B-4164", { chat_id: -5009453463, acc: false, head: false, mgr: false }),
    // B-3894: есть все, кроме менеджера
    chat("B-3894", { chat_id: -4903985247, acc: true, head: true, mgr: false }),
    // полностью укомплектованный — не в списке
    chat("OK клиент", { acc: true, head: true, mgr: true }),
  ];
  const { problems, counts } = computeProblems(rows);
  assert.equal(counts.total_chats, 4);
  assert.equal(counts.total_problems, 3);
  assert.equal(counts.missing_accountant, 1);
  assert.equal(counts.missing_head_accountant, 2);
  assert.equal(counts.missing_manager, 3);
});
