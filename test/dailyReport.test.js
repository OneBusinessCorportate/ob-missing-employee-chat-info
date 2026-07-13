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

// --- Новый блок: Ежедневная проверка клиентов/чатов ---
function checks(over = {}) {
  return {
    noResponsible: over.noResponsible || [],
    noHvhh: over.noHvhh || [],
    noChat: over.noChat || [],
    needsReview: over.needsReview || [],
    counts: {
      no_responsible: (over.noResponsible || []).length,
      no_hvhh: (over.noHvhh || []).length,
      no_chat: (over.noChat || []).length,
      needs_review: (over.needsReview || []).length,
      total_active: over.total_active ?? 0,
      ...over.counts,
    },
  };
}

test("блок клиентов/чатов: заголовок и три счётчика", () => {
  const msg = buildClientChecksBlock(
    checks({ counts: { no_responsible: 5, no_hvhh: 3, no_chat: 7 } }),
    "https://dash",
  );
  assert.match(msg, /📌 Ежедневная проверка клиентов\/чатов/);
  assert.match(msg, /Чаты без ответственных: 5/);
  assert.match(msg, /Нет HVHH в Agreements: 3/);
  assert.match(msg, /Нет чатов у активных месячных клиентов: 7/);
  assert.match(msg, /Полный список — на дашборде:\nhttps:\/\/dash/);
});

test("блок клиентов/чатов: короткий список с «кто отсутствует» и HVHH", () => {
  const msg = buildClientChecksBlock(
    checks({
      noResponsible: [
        { client: "ACME LLC", hvhh: "01234567", missing: "both" },
        { client: "Beta", hvhh: null, missing: "manager" },
      ],
    }),
    "",
  );
  assert.match(msg, /• ACME LLC, HVHH 01234567 — нет: оба/);
  assert.match(msg, /• Beta — нет: менеджер/);
});

test("блок клиентов/чатов: превью максимум 10, дальше «…и ещё N»", () => {
  const many = Array.from({ length: 13 }, (_, i) => ({
    client: `Client ${i}`,
    agr_no: `A-${i}`,
  }));
  const msg = buildClientChecksBlock(checks({ noHvhh: many }), "");
  assert.match(msg, /• Client 0 \(A-0\)/);
  assert.match(msg, /• Client 9 \(A-9\)/);
  assert.doesNotMatch(msg, /Client 10 \(A-10\)/);
  assert.match(msg, /…и ещё 3/);
});

test("блок клиентов/чатов: Needs review показывается только при наличии", () => {
  const withNr = buildClientChecksBlock(checks({ needsReview: [{}, {}] }), "");
  assert.match(withNr, /Needs review \(не удалось сопоставить\): 2/);
  const noNr = buildClientChecksBlock(checks({}), "");
  assert.doesNotMatch(noNr, /Needs review/);
});
