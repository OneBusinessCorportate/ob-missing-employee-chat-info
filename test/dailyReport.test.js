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

test("есть проблемы — новый формат «У нас есть N проблемных чатов» со ссылкой", () => {
  const msg = buildMessage(
    { total_chats: 727, total_problems: 235, missing_accountant: 62, missing_head_accountant: 208, missing_manager: 206 },
    "https://dash.example",
  );
  assert.match(msg, /У нас есть 235 проблемных чатов, из которых:/);
  assert.match(msg, /62 без бухгалтера/);
  assert.match(msg, /208 без главного бухгалтера/);
  assert.match(msg, /206 без менеджера/);
  assert.match(msg, /Чтобы увидеть больше информации, перейдите по ссылке:/);
  assert.match(msg, /https:\/\/dash\.example/);
});

test("доп. метрики добавляются в основной список при наличии clientCounts", () => {
  const msg = buildMessage(
    { total_chats: 700, total_problems: 18, missing_accountant: 14, missing_head_accountant: 1, missing_manager: 5 },
    "https://d",
    { no_hvhh: 29, no_chat: 15 },
  );
  assert.match(msg, /5 без менеджера\n29 нет HVHH в Agreements\n15 нет чатов у активных месячных клиентов/);
});

test("без clientCounts основной список не содержит доп. метрик", () => {
  const msg = buildMessage(
    { total_chats: 700, total_problems: 18, missing_accountant: 14, missing_head_accountant: 1, missing_manager: 5 },
    "https://d",
  );
  assert.doesNotMatch(msg, /нет HVHH в Agreements/);
  assert.doesNotMatch(msg, /нет чатов у активных/);
});

// Полное сообщение больше не содержит отдельного блока «Доп. информация» —
// две доп. метрики идут только строками в основном списке.
test("сообщение не содержит отдельного блока «Доп. информация»", () => {
  const msg = buildMessage(
    { total_chats: 700, total_problems: 20, missing_accountant: 15, missing_head_accountant: 2, missing_manager: 6 },
    "https://ob-missing-employee-chat-info.onrender.com/",
    { no_hvhh: 28, no_chat: 15 },
  );
  assert.doesNotMatch(msg, /Доп\. информация:/);
});
