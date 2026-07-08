// Тесты формирования текста ежедневной сводки, включая позитивный путь «0 проблем».
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage } from "../scripts/daily-report.js";

test("0 проблем — позитивное сообщение со ссылкой", () => {
  const msg = buildMessage({ total_problems: 0 }, "https://example.org");
  assert.match(msg, /Все чаты в порядке/);
  assert.match(msg, /https:\/\/example\.org/);
});

test("0 проблем без PLATFORM_URL — без ссылки, но не падает", () => {
  const msg = buildMessage({ total_problems: 0 }, "");
  assert.match(msg, /Все чаты в порядке/);
  assert.doesNotMatch(msg, /http/);
});

test("есть проблемы — перечисляет счётчики и даёт ссылку", () => {
  const msg = buildMessage(
    { total_problems: 7, missing_accountant: 3, missing_head_accountant: 5, missing_manager: 3 },
    "https://dash.example",
  );
  assert.match(msg, /7 проблемных чатов/);
  assert.match(msg, /3 без бухгалтера/);
  assert.match(msg, /5 без главного бухгалтера/);
  assert.match(msg, /3 без менеджера/);
  assert.match(msg, /https:\/\/dash\.example/);
});
