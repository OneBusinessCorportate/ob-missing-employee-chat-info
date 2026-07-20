// Юнит-тесты движка расчёта проблемных чатов (node:test, без Supabase).
// Вход соответствует строкам вью v_chat_missing_responsibles:
//   { chat_id, chat_name, has_accountant, has_head_accountant, has_manager }.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeProblems,
  isTestChat,
  groupProblemsByManager,
  UNASSIGNED_MANAGER,
} from "../lib/problemChats.js";

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

// --- Владелец чата: owner-поля прокидываются в проблемные чаты ---
test("owner-поля владельца прокидываются из строки вью в проблемный чат", () => {
  const { problems } = computeProblems([
    chat("c", {
      acc: false,
      owner_manager_id: "e1",
      owner_manager_name: "Shogher",
      owner_manager_username: "Manageronebusiness",
    }),
  ]);
  assert.equal(problems[0].owner_manager_name, "Shogher");
  assert.equal(problems[0].owner_manager_username, "Manageronebusiness");
  assert.equal(problems[0].owner_manager_id, "e1");
});

// --- Группировка проблемных чатов по менеджеру ---
function pchat(owner, username, miss = { acc: false }) {
  return {
    missing_accountant: !!miss.acc,
    missing_head_accountant: !!miss.head,
    missing_manager: !!miss.mgr,
    owner_manager_name: owner,
    owner_manager_username: username,
  };
}

test("группировка: по одному блоку на менеджера, счётчики и роли", () => {
  const groups = groupProblemsByManager([
    pchat("Shogher", "Manageronebusiness", { acc: true }),
    pchat("Shogher", "Manageronebusiness", { head: true }),
    pchat("Ripsime OneBusiness", "onebusiness_sale", { mgr: true }),
  ]);
  assert.equal(groups.length, 2);
  // Shogher первым — у него больше чатов (2 против 1).
  assert.equal(groups[0].manager_name, "Shogher");
  assert.equal(groups[0].total, 2);
  assert.equal(groups[0].username, "Manageronebusiness");
  assert.equal(groups[0].missing_accountant, 1);
  assert.equal(groups[0].missing_head_accountant, 1);
  assert.equal(groups[1].manager_name, "Ripsime OneBusiness");
  assert.equal(groups[1].total, 1);
  assert.equal(groups[1].missing_manager, 1);
});

test("группировка: несколько аккаунтов одного менеджера сводятся в один блок", () => {
  // У Ripsime два telegram-аккаунта; основной @-выбирается по числу чатов.
  const groups = groupProblemsByManager([
    pchat("Ripsime OneBusiness", "onebusiness_sale"),
    pchat("Ripsime OneBusiness", "onebusiness_sale"),
    pchat("Ripsime OneBusiness", "One_Business_sale"),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].total, 3);
  assert.equal(groups[0].username, "onebusiness_sale"); // основной аккаунт (2 из 3)
});

test("группировка: чаты без владельца собираются в блок без менеджера и идут в конце", () => {
  const groups = groupProblemsByManager([
    pchat(null, null),
    pchat("Shogher", "Manageronebusiness"),
    pchat("", ""),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].manager_name, "Shogher");
  const last = groups[groups.length - 1];
  assert.equal(last.manager_name, UNASSIGNED_MANAGER);
  assert.equal(last.assigned, false);
  assert.equal(last.total, 2);
  assert.equal(last.username, null);
});

test("группировка: пустой ввод не падает", () => {
  assert.deepEqual(groupProblemsByManager([]), []);
  assert.deepEqual(groupProblemsByManager(null), []);
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
