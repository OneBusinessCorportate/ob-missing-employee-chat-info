// Юнит-тесты движка расчёта проблемных чатов (node:test, без Supabase).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeProblems, isTestChat } from "../lib/problemChats.js";

// Хелпер: строка с участниками через вложенный participants (прод-схема).
function chat(name, { acc = [], head = [], mgr = [], ...rest } = {}) {
  return {
    id: name,
    chat_name: name,
    participants: { accountant: acc, head_accountant: head, manager: mgr },
    ...rest,
  };
}
const person = { name: "Иван", phone: "+374", username: "@ivan" };

test("все роли на месте — чат не проблемный", () => {
  const { problems, counts } = computeProblems([
    chat("ok", { acc: [person], head: [person], mgr: [person] }),
  ]);
  assert.equal(problems.length, 0);
  assert.equal(counts.total_problems, 0);
  assert.equal(counts.total_chats, 1);
});

test("нет бухгалтера", () => {
  const { problems, counts } = computeProblems([
    chat("c", { acc: [], head: [person], mgr: [person] }),
  ]);
  assert.equal(counts.total_problems, 1);
  assert.equal(counts.missing_accountant, 1);
  assert.equal(counts.missing_head_accountant, 0);
  assert.equal(counts.missing_manager, 0);
  assert.equal(problems[0].missing_accountant, true);
  assert.equal(problems[0].missing_count, 1);
});

test("нет главного бухгалтера", () => {
  const { counts } = computeProblems([chat("c", { acc: [person], head: [], mgr: [person] })]);
  assert.equal(counts.missing_head_accountant, 1);
  assert.equal(counts.total_problems, 1);
});

test("нет менеджера", () => {
  const { counts } = computeProblems([chat("c", { acc: [person], head: [person], mgr: [] })]);
  assert.equal(counts.missing_manager, 1);
  assert.equal(counts.total_problems, 1);
});

test("не хватает нескольких ролей — считается один раз в total, но в каждой роли", () => {
  const { problems, counts } = computeProblems([chat("c", { acc: [], head: [], mgr: [person] })]);
  assert.equal(counts.total_problems, 1);
  assert.equal(counts.missing_accountant, 1);
  assert.equal(counts.missing_head_accountant, 1);
  assert.equal(counts.missing_manager, 0);
  assert.equal(problems[0].missing_count, 2);
});

test("participants отсутствует полностью — все роли пустые", () => {
  const { problems, counts } = computeProblems([{ id: "x", chat_name: "no-part" }]);
  assert.equal(counts.total_problems, 1);
  assert.equal(counts.missing_accountant, 1);
  assert.equal(counts.missing_head_accountant, 1);
  assert.equal(counts.missing_manager, 1);
  assert.equal(problems[0].missing_count, 3);
});

test("fallback на плюральные колонки (accountants/head_accountants/managers)", () => {
  const { counts } = computeProblems([
    { id: "y", chat_name: "plural", accountants: [person], head_accountants: [], managers: [person] },
  ]);
  // accountant есть, head_accountant пуст, manager есть -> только head пропущен.
  assert.equal(counts.missing_accountant, 0);
  assert.equal(counts.missing_head_accountant, 1);
  assert.equal(counts.missing_manager, 0);
  assert.equal(counts.total_problems, 1);
});

test("дубликаты названий помечаются ambiguous", () => {
  const { problems } = computeProblems([
    chat("dup", { acc: [], contract_number: "111" }),
    chat("dup", { acc: [], contract_number: "222" }),
    chat("uniq", { acc: [] }),
  ]);
  const byName = Object.fromEntries(problems.map((p) => [p.contract_number || p.chat_name, p]));
  assert.equal(byName["111"].ambiguous, true);
  assert.equal(byName["222"].ambiguous, true);
  assert.equal(byName["uniq"].ambiguous, false);
});

test("data_updated_at — максимальная дата среди всех чатов", () => {
  const { counts } = computeProblems([
    chat("a", { updated_at: "2026-01-01T00:00:00Z" }),
    chat("b", { updated_at: "2026-06-01T00:00:00Z", acc: [person], head: [person], mgr: [person] }),
  ]);
  assert.equal(counts.data_updated_at, "2026-06-01T00:00:00Z");
});

test("пустой ввод не падает", () => {
  const empty = computeProblems([]);
  assert.equal(empty.counts.total_problems, 0);
  assert.equal(empty.counts.total_chats, 0);
  assert.equal(computeProblems(null).counts.total_chats, 0);
});

// Эталонный набор строк (совпадает с тестовыми данными в БД).
const P = [person];
const BASELINE_ROWS = [
  chat("testchat1", { acc: [], head: [], mgr: P }), // проблема: acc, head
  chat("testchat1", { acc: P, head: P, mgr: P }), // ок
  chat("testchat1", { acc: P, head: P, mgr: [] }), // проблема: mgr
  chat("testchat1", { acc: [], head: [], mgr: P }), // проблема: acc, head
  chat("testchat2", { acc: P, head: [], mgr: [] }), // проблема: head, mgr
  chat("testchat3", { acc: P, head: [], mgr: P }), // проблема: head
  chat("testchat4", { acc: P, head: P, mgr: [] }), // проблема: mgr
  chat("testchat5", { acc: [], head: [], mgr: P }), // проблема: acc, head
  chat("testchat52", { acc: P, head: P, mgr: P }), // ок
  chat("testchat64", { acc: P, head: P, mgr: P }), // ок
  chat("testchat67", { acc: P, head: P, mgr: P }), // ок
  chat("testchat67", { acc: P, head: P, mgr: P }), // ок
  chat("testchat6767", { acc: P, head: P, mgr: P }), // ок
  chat("testchatAaa", { acc: P, head: P, mgr: P }), // ок
];

// Регрессия против известного эталона (сырой движок, без исключения тестовых).
test("сырой движок: 14 -> 7 проблем -> 3 без бух / 5 без гл.бух / 3 без менеджера", () => {
  const { counts } = computeProblems(BASELINE_ROWS, { excludeTest: false });
  assert.equal(counts.total_chats, 14);
  assert.equal(counts.total_problems, 7);
  assert.equal(counts.missing_accountant, 3);
  assert.equal(counts.missing_head_accountant, 5);
  assert.equal(counts.missing_manager, 3);
});

test("isTestChat распознаёт тестовые чаты по имени", () => {
  assert.equal(isTestChat({ chat_name: "testchat1" }), true);
  assert.equal(isTestChat({ chat_name: "TestChat67" }), true);
  assert.equal(isTestChat({ chat_name: "  test blah" }), true);
  assert.equal(isTestChat({ chat_name: "ООО Ромашка" }), false);
  assert.equal(isTestChat({ chat_name: "" }), false);
  assert.equal(isTestChat({}), false);
});

test("по умолчанию тестовые чаты исключаются из списка и счётчиков", () => {
  const { problems, counts } = computeProblems(BASELINE_ROWS);
  assert.equal(problems.length, 0);
  assert.equal(counts.total_chats, 0);
  assert.equal(counts.total_problems, 0);
  assert.equal(counts.excluded_test, 14);
});

test("реальные чаты остаются, тестовые исключаются, счётчики верны", () => {
  const rows = [
    chat("testchat1", { acc: [], head: [], mgr: [] }), // тест — исключить
    chat("ООО Ромашка", { acc: [], head: P, mgr: P }), // реальный: нет бухгалтера
    chat("ИП Иванов", { acc: P, head: [], mgr: [] }), // реальный: нет гл.бух и менеджера
  ];
  const { problems, counts } = computeProblems(rows);
  assert.equal(counts.total_chats, 2);
  assert.equal(counts.excluded_test, 1);
  assert.equal(counts.total_problems, 2);
  assert.equal(counts.missing_accountant, 1);
  assert.equal(counts.missing_head_accountant, 1);
  assert.equal(counts.missing_manager, 1);
  assert.ok(problems.every((p) => !p.chat_name.startsWith("testchat")));
});

test("свой шаблон исключения через опции", () => {
  const rows = [chat("qa-demo", { acc: [] }), chat("ООО Клиент", { acc: [] })];
  const { counts } = computeProblems(rows, { testPattern: /^qa-/i });
  assert.equal(counts.excluded_test, 1);
  assert.equal(counts.total_chats, 1);
});
