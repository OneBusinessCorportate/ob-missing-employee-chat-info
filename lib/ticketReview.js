// Общая логика обязательного разбора «вчерашних» тикетов бухгалтерами.
//
// Единый источник правды для:
//   * серверного гейта (server.js) — блокирует бухгалтера, пока не обработаны
//     все обязательные тикеты за вчера;
//   * страницы разбора и её API (server.js /api/review/*);
//   * ежедневного отчёта в Telegram (scripts/daily-report.js, lib/ticketReport.js).
//
// Благодаря этому цифры на дашборде разбора и в Telegram не расходятся: и там,
// и там считает одна и та же функция.
//
// Источник данных — существующие таблицы платформы (проект OB FAQ):
//   * kk_problems                 — тикеты (проблемы), по одному на строку;
//   * kk_problem_acknowledgements — «Принять» (подтверждение проблемы);
//   * kk_problem_appeals          — «Подать апелляцию» (оспаривание + комментарий).
//
// Мы НИКОГДА не меняем строки kk_problems и другие исходные бизнес-таблицы —
// только читаем их и пишем в таблицы рабочего процесса (ack / appeals) через
// серверный сервис-ключ. См. sql/003_kk_review_gate.sql.
//
// Привязка тикета к «бизнес-дате»: тикет относится к тому календарному дню
// (в часовом поясе Asia/Yerevan), когда проблема была ОБНАРУЖЕНА — поле
// kk_problems.detected_at. Если detected_at пуст (в текущих данных не
// встречается), используем created_at как запасной вариант.

import { createClient } from "@supabase/supabase-js";
import { DEFAULT_TEST_PATTERN } from "./problemChats.js";

export const TZ = "Asia/Yerevan";

// Статусы тикета, которые ТРЕБУЮТ ответа бухгалтера и считаются «активными».
// Всё остальное (auto_resolved, acknowledged, appeal_*, fixed, in_review,
// submitted_by_accountant, explained_accepted) — уже обработано/неактуально и
// не должно блокировать работу.
export const ACTIVE_STATUSES = [
  "new",
  "waiting_for_accountant",
  "returned_to_accountant",
];

// Соответствие приоритета (kk_problems.priority) уровню серьёзности.
//   1 — критическая (🔴), 2 — средняя (🟠), 3 — лёгкая (🟢).
// Неизвестное/пустое значение считаем средним, чтобы тикет не потерялся.
export const SEVERITIES = [
  { key: "critical", label: "Критические проблемы", emoji: "🔴" },
  { key: "medium", label: "Средние проблемы", emoji: "🟠" },
  { key: "light", label: "Лёгкие проблемы", emoji: "🟢" },
];

export function severityOf(priority) {
  if (priority === 1 || priority === "1") return "critical";
  if (priority === 3 || priority === "3") return "light";
  return "medium";
}

// ---------------------------------------------------------------------------
// Расчёт «вчерашнего» календарного дня в часовом поясе Asia/Yerevan.
// Возвращает включительное начало и ИСКЛЮЧИТЕЛЬНЫЙ конец в виде Date (UTC),
// чтобы фильтр был `start <= ts < end`. Работает независимо от локального
// часового пояса сервера (Render/UTC) — все вычисления идут через Intl с явным
// timeZone, без new Date().setHours(...).
// ---------------------------------------------------------------------------

// Гражданская дата (Y-M-D) момента `date` в заданном поясе.
function zonedYMD(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(date).split("-").map(Number);
  return { y, m, d };
}

// Смещение пояса (мс) относительно UTC в момент `date`: tz_local - utc.
function zoneOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - date.getTime();
}

// UTC-момент локальной полуночи (00:00) даты (y,m,d) в поясе tz.
function zonedMidnightUtc(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Первый проход по смещению в точке-догадке, затем уточнение (защита от DST).
  let off = zoneOffsetMs(new Date(guess), tz);
  let real = guess - off;
  off = zoneOffsetMs(new Date(real), tz);
  real = guess - off;
  return new Date(real);
}

const pad2 = (n) => String(n).padStart(2, "0");

// Диапазон «предыдущего календарного дня» в поясе tz.
export function previousDayRange(now = new Date(), tz = TZ) {
  const today = zonedYMD(now, tz); // гражданская дата «сегодня» в поясе
  const todayStart = zonedMidnightUtc(today.y, today.m, today.d, tz);
  // Точка внутри вчерашнего дня — за 12 часов до начала сегодня; читаем её дату.
  const midYesterday = new Date(todayStart.getTime() - 12 * 60 * 60 * 1000);
  const yd = zonedYMD(midYesterday, tz);
  const startUtc = zonedMidnightUtc(yd.y, yd.m, yd.d, tz);
  const endUtc = todayStart; // исключительно: начало сегодняшнего дня
  return {
    startUtc,
    endUtc,
    ymd: `${yd.y}-${pad2(yd.m)}-${pad2(yd.d)}`,
    label: `${pad2(yd.d)}.${pad2(yd.m)}.${yd.y}`, // ДД.ММ.ГГГГ
  };
}

// ---------------------------------------------------------------------------
// Чистые функции отбора и подсчёта (без Supabase) — их покрывают тесты.
// ---------------------------------------------------------------------------

function isTestTicket(row, pattern = DEFAULT_TEST_PATTERN) {
  const name = (row && (row.chat_name || row.client_name)) || "";
  return pattern.test(name);
}

// «Бизнес-дата» тикета как Date: detected_at, иначе created_at.
export function ticketTimestamp(row) {
  const raw = row.detected_at || row.created_at || null;
  return raw ? new Date(raw) : null;
}

function inRange(ts, range) {
  return ts && ts >= range.startUtc && ts < range.endUtc;
}

// Короткая метка чата: код B-XXXX из названия, иначе номер договора, иначе имя.
export function chatCode(row) {
  const src = `${row.chat_name || ""} ${row.client_name || ""}`;
  const m = src.match(/B[-\s]?\d+/i);
  if (m) return m[0].replace(/\s+/g, "").toUpperCase();
  if (row.contract_id) return String(row.contract_id).trim();
  const name = (row.chat_name || row.client_name || "").trim();
  return name || "—";
}

// Короткий текст проблемы для списков.
export function problemText(row, max = 80) {
  const raw = (row.problem_title || row.problem_description || "").trim();
  const oneLine = raw.replace(/\s+/g, " ");
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

// Приводим строку тикета к безопасному для показа виду.
export function enrichTicket(row) {
  return {
    problem_id: row.problem_id,
    chat_name: row.chat_name || row.client_name || null,
    chat_code: chatCode(row),
    contract_id: row.contract_id || null,
    client_name: row.client_name || null,
    chat_link: row.chat_link || null,
    problem_title: row.problem_title || null,
    problem_description: row.problem_description || null,
    ai_comment: row.ai_comment || null,
    accountant_name: row.accountant_name || null,
    accountant_id: row.accountant_id != null ? String(row.accountant_id) : null,
    priority: row.priority ?? 2,
    severity: severityOf(row.priority),
    status: row.status || null,
    detected_at: row.detected_at || null,
  };
}

// Основной расчёт гейта для ОДНОГО бухгалтера.
// Принимает произвольный набор строк тикетов и множества problem_id, по которым
// уже есть подтверждение (acknowledgedIds) или апелляция (appealedIds).
// Отбрасывает: чужих бухгалтеров, не-вчерашние, неактивные, тестовые тикеты.
// Возвращает счётчики и список ещё не отвеченных тикетов.
export function computeAccountantGate(problems, opts = {}) {
  const {
    employeeId,
    range,
    acknowledgedIds = new Set(),
    appealedIds = new Set(),
    excludeTest = true,
    testPattern = DEFAULT_TEST_PATTERN,
  } = opts;

  const pending = [];
  let accepted = 0;
  let appealed = 0;

  for (const p of problems || []) {
    if (employeeId != null && String(p.accountant_id) !== String(employeeId)) continue;
    if (!inRange(ticketTimestamp(p), range)) continue;
    if (!ACTIVE_STATUSES.includes(p.status)) continue;
    if (excludeTest && isTestTicket(p, testPattern)) continue;

    if (acknowledgedIds.has(p.problem_id)) {
      accepted += 1;
      continue;
    }
    if (appealedIds.has(p.problem_id)) {
      appealed += 1;
      continue;
    }
    pending.push(enrichTicket(p));
  }

  const answered = accepted + appealed;
  const total = answered + pending.length;
  return {
    total,
    accepted,
    appealed,
    answered,
    unanswered: pending.length,
    tickets: pending,
    done: pending.length === 0,
  };
}

// Данные для ежедневного отчёта: разбивка по всем бухгалтерам, у кого вчера
// были активные тикеты. Использует те же правила отбора, что и гейт.
export function computeReport(problems, opts = {}) {
  const {
    range,
    acknowledgedIds = new Set(),
    appealedIds = new Set(),
    excludeTest = true,
    testPattern = DEFAULT_TEST_PATTERN,
  } = opts;

  const byAcc = new Map();
  const ensure = (id, name) => {
    const key = id || name || "(без имени)";
    if (!byAcc.has(key)) {
      byAcc.set(key, {
        accountant_id: id || null,
        accountant_name: name || "(без имени)",
        accepted: 0,
        appealed: 0,
        unanswered: 0,
        total: 0,
        severities: { critical: [], medium: [], light: [] },
      });
    }
    return byAcc.get(key);
  };

  for (const p of problems || []) {
    if (!inRange(ticketTimestamp(p), range)) continue;
    if (!ACTIVE_STATUSES.includes(p.status)) continue;
    if (excludeTest && isTestTicket(p, testPattern)) continue;

    const entry = ensure(
      p.accountant_id != null ? String(p.accountant_id) : null,
      p.accountant_name,
    );
    entry.total += 1;
    const sev = severityOf(p.priority);
    entry.severities[sev].push({
      problem_id: p.problem_id,
      chat_code: chatCode(p),
      text: problemText(p),
    });

    if (acknowledgedIds.has(p.problem_id)) entry.accepted += 1;
    else if (appealedIds.has(p.problem_id)) entry.appealed += 1;
    else entry.unanswered += 1;
  }

  return Array.from(byAcc.values()).sort((a, b) =>
    a.accountant_name.localeCompare(b.accountant_name, "ru"),
  );
}

// ---------------------------------------------------------------------------
// Решение гейта (чистая функция) — используется middleware сервера и тестами.
// Пути, которые всегда доступны (иначе будет редирект-петля и нельзя ответить
// на тикеты): вход/выход, страница и API разбора, health-check, favicon.
// ---------------------------------------------------------------------------
export const GATE_EXEMPT_PREFIXES = [
  "/healthz",
  "/login",
  "/logout",
  "/review",
  "/api/review",
  "/favicon",
];

export function isGateExempt(path) {
  const p = String(path || "");
  return GATE_EXEMPT_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

// Нужно ли блокировать запрос. Единственный обход — админ/менеджер (adm, т.е.
// login-код с can_see_all). Всех остальных на защищённом пути блокируем, пока
// не обработаны все вчерашние тикеты. Сессия без идентичности бухгалтера и без
// admin тоже блокируется (нельзя работать без входа по личному коду).
// (!session здесь означает «решение принимает requireAuth», не гейт.)
export function gateDecision({ session, unanswered, path }) {
  if (!session) return { blocked: false, reason: "no_session" };
  if (session.adm) return { blocked: false, reason: "admin" };
  if (isGateExempt(path)) return { blocked: false, reason: "exempt" };
  if (!session.emp) return { blocked: true, reason: "no_accountant" };
  if (Number(unanswered) > 0) return { blocked: true, reason: "unanswered" };
  return { blocked: false, reason: "clear" };
}

// ---------------------------------------------------------------------------
// Доступ к Supabase (только на сервере, через сервис-ключ). Клиент ленивый,
// чтобы чистые функции выше можно было тестировать без окружения.
// ---------------------------------------------------------------------------

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://fjsogozwseqoxgddjeig.supabase.co";

let _client = null;
export function getServiceClient() {
  if (_client) return _client;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — cannot read/write ticket review data.",
    );
  }
  _client = createClient(SUPABASE_URL, key, { auth: { persistSession: false } });
  return _client;
}

// Проверка личного кода входа бухгалтера по таблице login_codes (только на
// сервере, через сервис-ключ). Возвращает идентичность или null. can_see_all —
// признак привилегированной роли (менеджер/админ) с обходом гейта.
export async function lookupLoginCode(code) {
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) return null;
  const client = getServiceClient();
  const { data, error } = await client
    .from("login_codes")
    .select("code, employee_id, can_see_all, label, employees:employee_id(full_name, is_active)")
    .eq("code", trimmed)
    .maybeSingle();
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  if (!data) return null;
  const canSeeAll = Boolean(data.can_see_all);
  // Обычный код обязан быть привязан к бухгалтеру (employee_id). Админ-код
  // (can_see_all) может не иметь employee_id — это привилегированный вход без
  // персональных тикетов.
  if (!data.employee_id && !canSeeAll) return null;
  const emp = data.employees || {};
  return {
    employeeId: data.employee_id ? String(data.employee_id) : null,
    canSeeAll,
    name: emp.full_name || data.label || null,
    active: emp.is_active !== false,
  };
}

// Пагинированное чтение kk_problems за диапазон дат (по detected_at OR created_at).
async function fetchProblemsInRange(client, range, { accountantId = null } = {}) {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  const startIso = range.startUtc.toISOString();
  const endIso = range.endUtc.toISOString();
  for (;;) {
    let q = client
      .from("kk_problems")
      .select(
        "problem_id, source, client_name, contract_id, chat_name, chat_link, accountant_name, accountant_id, priority, problem_title, problem_description, ai_comment, detected_at, created_at, status",
      )
      .gte("detected_at", startIso)
      .lt("detected_at", endIso)
      .order("detected_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (accountantId != null) q = q.eq("accountant_id", String(accountantId));
    const { data, error } = await q;
    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Множества problem_id с подтверждением / действующей апелляцией для набора id.
async function fetchAnswerSets(client, problemIds) {
  const acknowledgedIds = new Set();
  const appealedIds = new Set();
  if (!problemIds.length) return { acknowledgedIds, appealedIds };

  const chunk = 500;
  for (let i = 0; i < problemIds.length; i += chunk) {
    const slice = problemIds.slice(i, i + chunk);
    const [ack, appeal] = await Promise.all([
      client.from("kk_problem_acknowledgements").select("problem_id").in("problem_id", slice),
      client
        .from("kk_problem_appeals")
        .select("problem_id, status")
        .in("problem_id", slice)
        .neq("status", "rejected"),
    ]);
    if (ack.error) throw new Error(`Supabase query failed: ${ack.error.message}`);
    if (appeal.error) throw new Error(`Supabase query failed: ${appeal.error.message}`);
    for (const r of ack.data || []) acknowledgedIds.add(r.problem_id);
    for (const r of appeal.data || []) appealedIds.add(r.problem_id);
  }
  return { acknowledgedIds, appealedIds };
}

function testOptsFromEnv() {
  const excludeTest = !["0", "false", "no"].includes(
    String(process.env.EXCLUDE_TEST_CHATS || "").toLowerCase(),
  );
  let testPattern = DEFAULT_TEST_PATTERN;
  if (process.env.TEST_CHAT_PATTERN) {
    try {
      testPattern = new RegExp(process.env.TEST_CHAT_PATTERN, "i");
    } catch {
      /* оставляем шаблон по умолчанию */
    }
  }
  return { excludeTest, testPattern };
}

// Состояние гейта для конкретного бухгалтера (для middleware и API разбора).
export async function loadAccountantGate(employeeId, now = new Date()) {
  const client = getServiceClient();
  const range = previousDayRange(now);
  const problems = await fetchProblemsInRange(client, range, {
    accountantId: employeeId,
  });
  const ids = problems.map((p) => p.problem_id);
  const { acknowledgedIds, appealedIds } = await fetchAnswerSets(client, ids);
  const gate = computeAccountantGate(problems, {
    employeeId,
    range,
    acknowledgedIds,
    appealedIds,
    ...testOptsFromEnv(),
  });
  return { ...gate, range };
}

// Данные для ежедневного отчёта по всем бухгалтерам за вчера.
export async function loadReportData(now = new Date()) {
  const client = getServiceClient();
  const range = previousDayRange(now);
  const problems = await fetchProblemsInRange(client, range);
  const ids = problems.map((p) => p.problem_id);
  const { acknowledgedIds, appealedIds } = await fetchAnswerSets(client, ids);
  const accountants = computeReport(problems, {
    range,
    acknowledgedIds,
    appealedIds,
    ...testOptsFromEnv(),
  });
  return { accountants, range };
}

// Максимальная длина комментария апелляции (символов).
export const MAX_COMMENT_LEN = 2000;

// Чистая валидация ответа бухгалтера на тикет. Не обращается к БД — проверяет
// уже загруженную строку тикета и параметры запроса. Возвращает {ok, error?,
// code?, comment?} — очищенный (trim) комментарий возвращается для записи.
export function validateAnswer({ action, ticket, employeeId, comment, range, now = new Date() }) {
  const r = range || previousDayRange(now);
  const fail = (code, error) => ({ ok: false, code, error });

  if (action !== "accept" && action !== "appeal") return fail("BAD_ACTION", "Некорректное действие.");
  if (!ticket) return fail("TICKET_NOT_FOUND", "Тикет не найден.");
  if (!employeeId) return fail("NO_IDENTITY", "Не удалось определить бухгалтера.");
  if (String(ticket.accountant_id) !== String(employeeId)) {
    return fail("NOT_OWNER", "Этот тикет назначен другому бухгалтеру.");
  }
  if (!inRange(ticketTimestamp(ticket), r)) {
    return fail("OUT_OF_RANGE", "Тикет не относится к обязательному дню разбора.");
  }
  if (!ACTIVE_STATUSES.includes(ticket.status)) {
    return fail("NOT_ELIGIBLE", "Тикет уже обработан или неактуален.");
  }

  let clean = null;
  if (action === "appeal") {
    clean = typeof comment === "string" ? comment.trim() : "";
    if (!clean) return fail("COMMENT_REQUIRED", "Для апелляции нужен непустой комментарий.");
    if (clean.length > MAX_COMMENT_LEN) {
      return fail("COMMENT_TOO_LONG", `Комментарий слишком длинный (максимум ${MAX_COMMENT_LEN}).`);
    }
  } else if (typeof comment === "string" && comment.trim()) {
    // Для «Принять» комментарий необязателен, но если прислан — сохраняем.
    clean = comment.trim().slice(0, MAX_COMMENT_LEN);
  }

  return { ok: true, comment: clean };
}

// Атомарная запись ответа через серверную функцию kk_review_submit (SECURITY
// DEFINER). Функция под advisory-lock исключает гонки и невозможность
// одновременного «принять» и «апелляции» одного тикета. Возвращает
// {status:'ok'|'already', action}. Ничего не меняет в самих строках kk_problems.
export async function submitAnswer({ action, problemId, employeeId, accountantName, comment, range }) {
  const client = getServiceClient();
  const r = range || previousDayRange();
  const { data, error } = await client.rpc("kk_review_submit", {
    p_problem_id: problemId,
    p_accountant_id: String(employeeId),
    p_accountant_name: accountantName || null,
    p_action: action,
    p_comment: comment ?? null,
    p_range_start: r.startUtc.toISOString(),
    p_range_end: r.endUtc.toISOString(),
  });
  if (error) {
    // Пробрасываем коды из RAISE EXCEPTION (message) как есть — сервер их
    // маппит в безопасные русские сообщения, не раскрывая деталей БД.
    const msg = (error.message || "").toUpperCase();
    const known = [
      "TICKET_NOT_FOUND",
      "NOT_OWNER",
      "OUT_OF_RANGE",
      "NOT_ELIGIBLE",
      "COMMENT_REQUIRED",
      "ALREADY_ACCEPTED",
      "ALREADY_APPEALED",
      "BAD_ACTION",
    ].find((c) => msg.includes(c));
    const err = new Error(known || "DB_ERROR");
    err.code = known || "DB_ERROR";
    throw err;
  }
  return data || { status: "ok", action };
}

// Единичный тикет для сервера (проверка владельца/срока перед записью).
export async function fetchTicket(problemId) {
  const client = getServiceClient();
  const { data, error } = await client
    .from("kk_problems")
    .select(
      "problem_id, client_name, contract_id, chat_name, accountant_name, accountant_id, priority, problem_title, problem_description, detected_at, created_at, status",
    )
    .eq("problem_id", problemId)
    .maybeSingle();
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return data || null;
}
