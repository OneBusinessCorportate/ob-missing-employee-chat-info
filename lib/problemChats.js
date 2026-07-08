// Общая логика: читаем реальный источник — чаты (public.chats) и присутствие
// ответственных в них (public.chat_employee_presence) — через read-only вью
// public.v_chat_missing_responsibles и определяем, в каких чатах не хватает
// ответственного. Используется и веб-API (server.js), и ежедневной сводкой
// (scripts/daily-report.js), поэтому цифры на дашборде и в Telegram совпадают.
//
// Вью отдаёт по одной строке на проверяемый чат (is_active и не исключён из QA)
// с флагами наличия ответственных:
//   has_accountant, has_head_accountant, has_manager, checked_at.
// «Не хватает роли» = соответствующего присутствующего ответственного нет.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://fjsogozwseqoxgddjeig.supabase.co";

// Имя read-only вью с агрегированными флагами наличия ответственных.
const SOURCE_VIEW = "v_chat_missing_responsibles";

// Сервисный ключ нужен, т.к. на исходных таблицах включён RLS. Ключ остаётся
// только на сервере. Клиент создаётся лениво, чтобы чистые функции
// (computeProblems) можно было импортировать/тестировать без env.
let _client = null;
function getClient() {
  if (_client) return _client;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — cannot read from Supabase. " +
        "Set it in the environment (Render / .env).",
    );
  }
  _client = createClient(SUPABASE_URL, key, { auth: { persistSession: false } });
  return _client;
}

// Три роли, которые проверяет чек-лист.
export const TRACKED_ROLES = [
  { key: "accountant", label: "Бухгалтер", flag: "missing_accountant" },
  { key: "head_accountant", label: "Главный бухгалтер", flag: "missing_head_accountant" },
  { key: "manager", label: "Менеджер", flag: "missing_manager" },
];

// Тестовые/служебные чаты (напр. «testchat67») не должны попадать в реальный
// чек-лист. По умолчанию исключаем всё, чьё название начинается с «test».
// Шаблон можно переопределить через env TEST_CHAT_PATTERN.
export const DEFAULT_TEST_PATTERN = /^\s*test/i;

export function isTestChat(row, pattern = DEFAULT_TEST_PATTERN) {
  const name = (row && row.chat_name) || "";
  return pattern.test(name);
}

// Pure reducer: из строк вью формирует список проблемных чатов и счётчики.
// Без побочных эффектов — тестируется без Supabase.
// opts.excludeTest (по умолчанию true) отбрасывает тестовые чаты;
// opts.testPattern задаёт свой шаблон их распознавания.
export function computeProblems(data, opts = {}) {
  const { excludeTest = true, testPattern = DEFAULT_TEST_PATTERN } = opts;
  const allRows = data || [];

  // Сначала отсекаем тестовые чаты — они не влияют ни на список, ни на счётчики.
  const excludedTest = excludeTest
    ? allRows.filter((r) => isTestChat(r, testPattern)).length
    : 0;
  const rows = excludeTest
    ? allRows.filter((r) => !isTestChat(r, testPattern))
    : allRows;

  // Названия чатов не уникальны (встречаются дубли) — считаем повторы, чтобы
  // пометить такие строки как «неоднозначные» и показать Chat ID для различения.
  const nameCounts = new Map();
  for (const row of rows) {
    const name = row.chat_name || "(без названия)";
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }

  const chats = rows.map((row) => {
    // «Не хватает» = нет присутствующего ответственного этой роли.
    const missing_accountant = !row.has_accountant;
    const missing_head_accountant = !row.has_head_accountant;
    const missing_manager = !row.has_manager;
    const chat_name = row.chat_name || "(без названия)";
    // Число отсутствующих ролей — для сортировки «сначала худшие».
    const missing_count =
      (missing_accountant ? 1 : 0) +
      (missing_head_accountant ? 1 : 0) +
      (missing_manager ? 1 : 0);
    return {
      chat_id: row.chat_id != null ? String(row.chat_id) : null,
      chat_name,
      checked_at: row.checked_at || null,
      missing_accountant,
      missing_head_accountant,
      missing_manager,
      missing_count,
      ambiguous: nameCounts.get(chat_name) > 1,
    };
  });

  const problems = chats.filter(
    (c) => c.missing_accountant || c.missing_head_accountant || c.missing_manager,
  );

  // Самое свежее время проверки — показываем как «данные актуальны на …».
  let dataUpdatedAt = null;
  for (const row of rows) {
    if (row.checked_at && (!dataUpdatedAt || row.checked_at > dataUpdatedAt)) {
      dataUpdatedAt = row.checked_at;
    }
  }

  const counts = {
    total_problems: problems.length,
    missing_accountant: problems.filter((c) => c.missing_accountant).length,
    missing_head_accountant: problems.filter((c) => c.missing_head_accountant).length,
    missing_manager: problems.filter((c) => c.missing_manager).length,
    total_chats: chats.length, // всего проверено (после исключения тестовых)
    excluded_test: excludedTest,
    data_updated_at: dataUpdatedAt,
  };

  return { problems, counts };
}

// Опции исключения тестовых чатов из окружения:
//   EXCLUDE_TEST_CHATS=0  — не исключать (по умолчанию исключаем);
//   TEST_CHAT_PATTERN     — свой regexp (по умолчанию «^test», без учёта регистра).
function testOptsFromEnv() {
  const excludeTest = !["0", "false", "no"].includes(
    String(process.env.EXCLUDE_TEST_CHATS || "").toLowerCase(),
  );
  let testPattern = DEFAULT_TEST_PATTERN;
  if (process.env.TEST_CHAT_PATTERN) {
    try {
      testPattern = new RegExp(process.env.TEST_CHAT_PATTERN, "i");
    } catch {
      // Некорректный шаблон — оставляем значение по умолчанию.
    }
  }
  return { excludeTest, testPattern };
}

// Читает все строки вью (с пагинацией на случай роста числа чатов) и сводит их.
// Чат проблемный, если не хватает хотя бы одной отслеживаемой роли.
export async function getProblemChats() {
  const client = getClient();
  const pageSize = 1000;
  let from = 0;
  let all = [];
  // PostgREST по умолчанию может ограничивать выдачу — читаем страницами.
  for (;;) {
    const { data, error } = await client
      .from(SOURCE_VIEW)
      .select("chat_id, chat_name, has_accountant, has_head_accountant, has_manager, checked_at")
      .order("chat_name", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return computeProblems(all, testOptsFromEnv());
}
