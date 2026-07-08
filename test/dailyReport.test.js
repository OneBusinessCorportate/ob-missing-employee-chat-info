// Тесты формирования текста ежедневной сводки, включая позитивные пути.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage } from "../scripts/daily-report.js";

test("0 проблем при наличии чатов — позитивное сообщение со ссылкой", () => {
  const msg = buildMessage({ total_problems: 0, total_chats: 700 }, "https://example.org");
  assert.match(msg, /Все чаты в порядке/);
  assert.match(msg, /https:\/\/example\.org/);
});

test("нет чатов для проверки — отдельное сообщение, не ложное «всё ок»", () => {
  const msg = buildMessage({ total_problems: 0, total_chats: 0 }, "https://example.org");
  assert.match(msg, /Чатов для проверки пока нет/);
  assert.doesNotMatch(msg, /в порядке/);
});

test("0 проблем без PLATFORM_URL — без ссылки, не падает", () => {
  const msg = buildMessage({ total_problems: 0, total_chats: 700 }, "");
  assert.match(msg, /Все чаты в порядке/);
  assert.doesNotMatch(msg, /http/);
});

test("есть проблемы — формат отчёта со счётчиками и ссылкой", () => {
  const msg = buildMessage(
    { total_chats: 727, total_problems: 235, missing_accountant: 62, missing_head_accountant: 208, missing_manager: 206 },
    "https://dash.example",
  );
  assert.match(msg, /Ежедневная проверка/);
  assert.match(msg, /Всего чатов проверено: 727/);
  assert.match(msg, /Чатов с неполной информацией: 235/);
  assert.match(msg, /62 без бухгалтера/);
  assert.match(msg, /208 без главного бухгалтера/);
  assert.match(msg, /206 без менеджера/);
  assert.match(msg, /https:\/\/dash\.example/);
});

test("непроверенные чаты упоминаются отдельной строкой", () => {
  const withNc = buildMessage(
    { total_chats: 677, total_problems: 183, missing_accountant: 11, missing_head_accountant: 157, missing_manager: 156, not_checked: 50 },
    "https://d",
  );
  assert.match(withNc, /Не проверено \(нет данных\): 50/);
  const noNc = buildMessage(
    { total_chats: 677, total_problems: 183, missing_accountant: 11, missing_head_accountant: 157, missing_manager: 156, not_checked: 0 },
    "https://d",
  );
  assert.doesNotMatch(noNc, /Не проверено/);
});
