// Тесты формирования текста ежедневной сводки, включая позитивные пути.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage, buildClientChecksBlock } from "../scripts/daily-report.js";

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

// --- Новый блок: «dop info» (две дополнительные метрики) ---
test("dop info: заголовок и две метрики (HVHH и чаты)", () => {
  const msg = buildClientChecksBlock({ counts: { no_hvhh: 29, no_chat: 15 } });
  assert.match(msg, /dop info:/);
  assert.match(msg, /Нет HVHH в Agreements: 29/);
  assert.match(msg, /Нет чатов у активных месячных клиентов: 15/);
});

test("dop info: компактный — без «Чаты без ответственных» и без списков клиентов", () => {
  const msg = buildClientChecksBlock({
    counts: { no_responsible: 682, no_hvhh: 29, no_chat: 15, needs_review: 0 },
  });
  assert.doesNotMatch(msg, /Чаты без ответственных/);
  assert.doesNotMatch(msg, /•/);
  assert.doesNotMatch(msg, /682/);
});
