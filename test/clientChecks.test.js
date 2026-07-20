// Юнит-тесты движка ежедневной проверки клиентов/чатов (без Supabase).
// Вход соответствует строкам mqa_chats (активные клиенты):
//   { agr_no, hvhh, name_agr, name_tax, status, chat_name, chat_link,
//     accountant, manager }.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeClientChecks, clientLabel } from "../lib/clientChecks.js";

// Хелпер: по умолчанию — «здоровый» активный клиент (все поля заполнены).
function client(over = {}) {
  return {
    agr_no: "B-1000",
    hvhh: "01234567",
    name_agr: "ACME LLC",
    name_tax: "ԱՔՄԵ ՍՊԸ",
    status: "Active",
    chat_name: "ACME чат",
    chat_link: "https://web.telegram.org/a/#-100500",
    accountant: "Գայանե",
    manager: "manager_onebusiness",
    ...over,
  };
}

test("здоровый клиент не попадает ни в один список", () => {
  const { counts } = computeClientChecks([client()]);
  assert.equal(counts.no_responsible, 0);
  assert.equal(counts.no_hvhh, 0);
  assert.equal(counts.no_chat, 0);
  assert.equal(counts.needs_review, 0);
  assert.equal(counts.total_active, 1);
});

// --- 1) Чаты без ответственных (нет бухгалтера ИЛИ менеджера) ---
test("нет бухгалтера — missing=accountant", () => {
  const { noResponsible, counts } = computeClientChecks([client({ accountant: null })]);
  assert.equal(counts.no_responsible, 1);
  assert.equal(noResponsible[0].missing, "accountant");
});

test("нет менеджера — missing=manager", () => {
  const { noResponsible, counts } = computeClientChecks([client({ manager: "" })]);
  assert.equal(counts.no_responsible, 1);
  assert.equal(noResponsible[0].missing, "manager");
});

test("нет обоих — missing=both", () => {
  const { noResponsible } = computeClientChecks([
    client({ accountant: "   ", manager: null }),
  ]);
  assert.equal(noResponsible[0].missing, "both");
});

test("пустая строка/пробелы считаются отсутствием ответственного", () => {
  const { counts } = computeClientChecks([client({ manager: "   " })]);
  assert.equal(counts.no_responsible, 1);
});

// --- 2) Нет HVHH в Agreements ---
test("пустой HVHH попадает в noHvhh, а заполненный — нет", () => {
  const { noHvhh, counts } = computeClientChecks([
    client({ agr_no: "B-1", name_agr: "AAA", chat_name: "AAA", hvhh: null }),
    client({ agr_no: "B-2", name_agr: "BBB", chat_name: "BBB", hvhh: "" }),
    client({ agr_no: "B-3", name_agr: "CCC", chat_name: "CCC", hvhh: "88888888" }),
  ]);
  assert.equal(counts.no_hvhh, 2);
  assert.deepEqual(
    noHvhh.map((r) => r.agr_no).sort(),
    ["B-1", "B-2"],
  );
});

test("пустой HVHH, но есть номер договора (4+ цифр) — НЕ считается «нет HVHH»", () => {
  const { noHvhh, counts } = computeClientChecks([
    client({ agr_no: "B-4233", name_agr: "ACME", chat_name: "ACME", hvhh: null }),
    client({ agr_no: "ИП Гончар/ 4345 RU", name_agr: null, chat_name: null, hvhh: "" }),
    client({ agr_no: "SQA-VONABI", name_agr: "VONABI", chat_name: "VONABI", hvhh: null }),
  ]);
  // Первые две строки имеют номер договора → пропускаем; остаётся только VONABI.
  assert.equal(counts.no_hvhh, 1);
  assert.deepEqual(noHvhh.map((r) => r.agr_no), ["SQA-VONABI"]);
});

// --- 3) Нет чатов у активных месячных клиентов ---
test("нет ссылки на чат — клиент в noChat с типом monthly", () => {
  const { noChat, counts } = computeClientChecks([client({ chat_link: null })]);
  assert.equal(counts.no_chat, 1);
  assert.equal(noChat[0].client_type, "monthly");
  assert.equal(noChat[0].missing, "Telegram chat");
});

test("есть ссылка на чат — в noChat не попадает", () => {
  const { counts } = computeClientChecks([client({ chat_link: "https://t.me/x" })]);
  assert.equal(counts.no_chat, 0);
});

// --- Клиент участвует сразу в нескольких списках ---
test("один клиент может попасть во все три списка", () => {
  const { counts } = computeClientChecks([
    client({
      agr_no: "B-1",
      name_agr: "NoNumber",
      chat_name: "NoNumber",
      accountant: null,
      manager: null,
      hvhh: null,
      chat_link: null,
    }),
  ]);
  assert.equal(counts.no_responsible, 1);
  assert.equal(counts.no_hvhh, 1);
  assert.equal(counts.no_chat, 1);
});

// --- clientLabel: приоритет источников имени ---
test("clientLabel берёт name_agr, затем name_tax, затем chat_name, затем № договора, затем HVHH", () => {
  assert.equal(clientLabel({ name_agr: "A", name_tax: "B" }), "A");
  assert.equal(clientLabel({ name_tax: "B", chat_name: "C" }), "B");
  assert.equal(clientLabel({ chat_name: "C", agr_no: "B-9" }), "C");
  assert.equal(clientLabel({ agr_no: "B-9" }), "Договор B-9");
  assert.equal(clientLabel({ hvhh: "555" }), "HVHH 555");
  assert.equal(clientLabel({}), null);
});

// --- Needs review: клиента невозможно идентифицировать ---
test("строка без идентификаторов уходит в Needs review и не считается в метриках", () => {
  const { counts, needsReview } = computeClientChecks([
    {
      agr_no: null,
      hvhh: null,
      name_agr: null,
      name_tax: null,
      chat_name: null,
      chat_link: null,
      accountant: null,
      manager: null,
      status: "Active",
    },
  ]);
  assert.equal(counts.needs_review, 1);
  assert.equal(counts.no_responsible, 0);
  assert.equal(counts.no_hvhh, 0);
  assert.equal(counts.no_chat, 0);
  assert.equal(needsReview[0].reason, "no_identifier");
});

test("пустой ввод не падает", () => {
  const empty = computeClientChecks([]);
  assert.equal(empty.counts.total_active, 0);
  assert.equal(computeClientChecks(null).counts.no_responsible, 0);
});
