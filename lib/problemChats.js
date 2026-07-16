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
//
// Важно: чат учитывается в проблемах ТОЛЬКО если он реально проверялся
// (row.checked === true — есть данные присутствия или сообщения). Чаты без
// данных (бот ещё не в чате / не выгружены) попадают в отдельный список
// notChecked и НЕ считаются «без ответственных», чтобы не было ложных тревог.
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

  const problems = [];
  const notChecked = [];
  let dataUpdatedAt = null;

  for (const row of rows) {
    const chat_name = row.chat_name || "(без названия)";
    const chat_id = row.chat_id != null ? String(row.chat_id) : null;
    const ambiguous = nameCounts.get(chat_name) > 1;
    // checked по умолчанию true, если поле не пришло (обратная совместимость).
    const checked = row.checked !== false;

    if (row.checked_at && (!dataUpdatedAt || row.checked_at > dataUpdatedAt)) {
      dataUpdatedAt = row.checked_at;
    }

    if (!checked) {
      // Нет данных: не знаем, есть ли ответственные — не помечаем как проблему.
      notChecked.push({
        chat_id,
        chat_name,
        checked: false,
        no_data: true,
        checked_at: row.checked_at || null,
        ambiguous,
      });
      continue;
    }

    // «Не хватает» = роль ТРЕБУЕТСЯ для этого чата и нет присутствующего/писавшего
    // (или отмеченного вручную как present) ответственного этой роли.
    // req_* по умолчанию true, если поле не пришло (обратная совместимость и
    // старые вью без оверрайдов). Оверрайд not_required делает req_*=false и
    // убирает роль из требуемых, поэтому она не считается пропуском.
    const req_accountant = row.req_accountant !== false;
    const req_head_accountant = row.req_head_accountant !== false;
    const req_manager = row.req_manager !== false;
    const missing_accountant = req_accountant && !row.has_accountant;
    const missing_head_accountant = req_head_accountant && !row.has_head_accountant;
    const missing_manager = req_manager && !row.has_manager;
    const missing_count =
      (missing_accountant ? 1 : 0) +
      (missing_head_accountant ? 1 : 0) +
      (missing_manager ? 1 : 0);

    if (missing_count > 0) {
      problems.push({
        chat_id,
        chat_name,
        checked: true,
        checked_at: row.checked_at || null,
        missing_accountant,
        missing_head_accountant,
        missing_manager,
        missing_count,
        ambiguous,
      });
    }
  }

  const checkedCount = rows.length - notChecked.length;
  const counts = {
    total_problems: problems.length,
    missing_accountant: problems.filter((c) => c.missing_accountant).length,
    missing_head_accountant: problems.filter((c) => c.missing_head_accountant).length,
    missing_manager: problems.filter((c) => c.missing_manager).length,
    total_chats: checkedCount, // всего РЕАЛЬНО проверено (после исключения тестовых)
    not_checked: notChecked.length, // чатов без данных (не проверены)
    excluded_test: excludedTest,
    data_updated_at: dataUpdatedAt,
  };

  return { problems, notChecked, counts };
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
  // Сортируем по chat_id (уникальный), а не по chat_name: названия не уникальны,
  // и при пагинации по неуникальному полю строки на границах страниц могли бы
  // теряться или дублироваться. Итоговый порядок для показа задаёт фронтенд.
  for (;;) {
    const { data, error } = await client
      .from(SOURCE_VIEW)
      .select(
        "chat_id, chat_name, has_accountant, has_head_accountant, has_manager, " +
          "req_accountant, req_head_accountant, req_manager, checked, checked_at",
      )
      .order("chat_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return computeProblems(all, testOptsFromEnv());
}
