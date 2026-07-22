// Юнит-тесты движка «Контроль количества клиентов» (без Supabase, без файлов).
// Проверяем чистую функцию computeClientCount и хелперы нормализации/классификации.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeClientCount,
  chatChannel,
  botStatusFromIssue,
  normHvhh,
  normName,
} from "../lib/clientCount.js";

test("chatChannel классифицирует ссылку/значение", () => {
  assert.equal(chatChannel("https://web.telegram.org/a/#-100"), "telegram");
  assert.equal(chatChannel("https://t.me/xxx"), "telegram");
  assert.equal(chatChannel("чат в вотс ап"), "whatsapp");
  assert.equal(chatChannel("https://web.whatsapp.com"), "whatsapp");
  assert.equal(chatChannel("client@gmail.com"), "mail");
  assert.equal(chatChannel("не работаем"), "not_working");
  assert.equal(chatChannel(""), "none");
});

test("botStatusFromIssue читает статус бота из выгрузки", () => {
  assert.equal(botStatusFromIssue("OK", "True"), "ok");
  assert.equal(botStatusFromIssue("Нет бота", "False"), "no_bot");
  assert.equal(botStatusFromIssue("once (closed)", ""), "once");
  assert.equal(botStatusFromIssue("status unknown", ""), "unknown");
  assert.equal(botStatusFromIssue("", "True"), "ok");
  assert.equal(botStatusFromIssue("", "False"), "no_bot");
  assert.equal(botStatusFromIssue("", ""), "unlisted");
});

test("normHvhh оставляет только цифры, normName нормализует имя", () => {
  assert.equal(normHvhh(" 08428944 "), "08428944");
  assert.equal(normHvhh(1234), "1234");
  assert.equal(normName('"ACME" LLC'), "acmellc");
});

test("склейка по HVHH: одна компания из нескольких источников", () => {
  const r = computeClientCount({
    agreements: [{ agr_no: "10", company: "ACME LLC", hvhh: "01234567", status: "Active" }],
    onebusiness: [{ agr_no: "10", client_name: "ACME LLC", hvhh: "01234567", status: "Active", accountant: "Анна" }],
    chatsSheet: [{ agr_no: "10", hvhh: "01234567", name_agr: "ACME", status: "Active", chat_name: "ACME чат", chat_link: "https://web.telegram.org/#-100" }],
    chatsWithoutBot: [{ chat_name: "ACME чат", bot_exists: "True", issue_type: "OK", chat_id: "-100" }],
  });
  assert.equal(r.universe.total, 1);
  const co = r.all_companies[0];
  assert.equal(co.hvhh, "01234567");
  assert.equal(co.accountant, "Анна");
  assert.equal(co.bucket, "in_bot");
  assert.deepEqual(co.sources.sort(), ["agreements", "chats_sheet", "onebusiness"]);
});

test("разные договоры с одинаковым именем НЕ склеиваются", () => {
  const r = computeClientCount({
    agreements: [
      { agr_no: "1585", company: "GREEN LLC", hvhh: "", status: "Active" },
      { agr_no: "1816", company: "GREEN LLC", hvhh: "", status: "Active" },
    ],
  });
  assert.equal(r.universe.total, 2);
});

test("ведёрки: telegram без бота, whatsapp, не найден", () => {
  const r = computeClientCount({
    agreements: [
      { agr_no: "1", company: "A", hvhh: "1", status: "Active" },
      { agr_no: "2", company: "B", hvhh: "2", status: "Active" },
      { agr_no: "3", company: "C", hvhh: "3", status: "Active" },
    ],
    chatsSheet: [
      { agr_no: "1", hvhh: "1", name_agr: "A", status: "Active", chat_name: "A чат", chat_link: "https://web.telegram.org/#-1" },
      { agr_no: "2", hvhh: "2", name_agr: "B", status: "Active", chat_name: "B чат", chat_link: "https://web.whatsapp.com" },
      // C — нет строки в листе «Чаты» -> not_found
    ],
    chatsWithoutBot: [{ chat_name: "A чат", bot_exists: "False", issue_type: "Нет бота", chat_id: "-1" }],
  });
  assert.equal(r.buckets.telegram_no_bot, 1); // A
  assert.equal(r.buckets.other_channel, 1); // B (whatsapp)
  assert.equal(r.buckets.not_found, 1); // C
  assert.equal(r.buckets.in_bot, 0);
  // Все три попадают в план действий (for_harry)
  assert.equal(r.action_rows.length, 3);
});

test("отказники и неактивные считаются исключениями, не активными", () => {
  const r = computeClientCount({
    agreements: [
      { agr_no: "1", company: "Active Co", hvhh: "1", status: "Active" },
      { agr_no: "2", company: "Inactive Co", hvhh: "2", status: "Inactive" },
      { agr_no: "3", company: "Left Co", hvhh: "3", status: "Active" },
    ],
    refuseniks: [{ agr_no: "3", company: "Left Co", reason: "ушёл" }],
  });
  assert.equal(r.universe.by_class.active, 1); // только Active Co
  assert.equal(r.universe.by_class.inactive, 1);
  assert.equal(r.universe.by_class.refusenik, 1);
  const left = r.all_companies.find((c) => c.agr_no === "3");
  assert.equal(left.is_refusenik, true);
  assert.equal(left.status_class, "refusenik");
});

test("чаты на аккаунте без бота выводятся отдельным списком (раздел 5)", () => {
  const r = computeClientCount({
    chatsWithoutBot: [
      { chat_name: "Чат 1", bot_exists: "False", issue_type: "Нет бота", chat_id: "-1", chat_link: "https://t.me/x" },
      { chat_name: "Чат 2", bot_exists: "True", issue_type: "OK", chat_id: "-2" },
      { chat_name: "Чат 3", bot_exists: "", issue_type: "once (closed)", chat_id: "-3" },
    ],
  });
  assert.equal(r.manager_chats_no_bot.length, 1);
  assert.equal(r.manager_chats_no_bot[0].chat_name, "Чат 1");
  assert.equal(r.manager_chats_unclear, 1);
});

test("живые данные Supabase (mqa) добавляются как источник и канал", () => {
  const r = computeClientCount(
    { agreements: [{ agr_no: "1", company: "A", hvhh: "1", status: "Active" }] },
    { mqaActive: [{ agr_no: "1", hvhh: "1", name_agr: "A", status: "Active", chat_link: "https://web.telegram.org/#-1", chat_name: "A чат", accountant: "Ани", manager: "M" }], chatsActive: 5, chatsTotal: 6 },
  );
  const co = r.all_companies[0];
  assert.ok(co.sources.includes("mqa"));
  assert.equal(co.accountant, "Ани");
  assert.equal(co.manager, "M");
  assert.equal(co.chat_channel, "telegram");
  const live = r.source_totals.find((t) => t.key === "chats_live");
  assert.equal(live.total, 5);
});

test("пустой вход не падает", () => {
  const r = computeClientCount({}, {});
  assert.equal(r.universe.total, 0);
  assert.equal(r.action_rows.length, 0);
  assert.equal(r.manager_chats_no_bot.length, 0);
  assert.ok(typeof r.harry_message === "string");
});
