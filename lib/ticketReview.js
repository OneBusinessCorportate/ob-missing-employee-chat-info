// Единый модуль «обработки вчерашних тикетов».
//
// Одна и та же логика обслуживает: серверную блокировку (gate), страницу
// разбора, API, дашборд-цифры и ежедневную сводку в Telegram — чтобы счётчики
// НИГДЕ не расходились. Чистые функции (даты, отбор, подсчёт, severity, текст
// отчёта) не зависят от Supabase и полностью тестируются; функции ввода-вывода
// (чтение kk_problems, запись согласия/апелляции) вынесены отдельно.
//
// Что такое «тикет»: строка public.kk_problems из ручной проверки качества —
// source ∈ {margarita_review, sona_review}. «Живые» AI-обнаружения (source='ai')
// НЕ входят: соседнее приложение их отключило (0022/0023), для бухгалтера это не
// тикеты. Мы НЕ меняем сами строки kk_problems (правило read-only для бизнес-
// таблиц) — согласие/апелляция пишутся в отдельные рабочие таблицы
// kk_problem_acknowledgements / kk_problem_appeals, а «отвечен ли тикет»
// вычисляется по ним.
//
// Бизнес-дата тикета = календарный день его detected_at в зоне Asia/Yerevan.
// «Вчера» = полный предыдущий календарный день в Asia/Yerevan (не «минус 24 ч»).

import { isTestChat, DEFAULT_TEST_PATTERN } from "./problemChats.js";
import { getServiceClient } from "./supabaseServer.js";

// ---------------------------------------------------------------------------
// 1. Даты в зоне Asia/Yerevan (устойчиво к UTC-времени сервера Render)
// ---------------------------------------------------------------------------

export const REVIEW_TZ = "Asia/Yerevan";

// Сдвиг зоны относительно UTC (в мс) в конкретный момент. Через Intl — корректно
// при любом переводе часов (в Армении перевода нет, но метод универсален и не
// зависит от локального времени сервера). Значение = насколько локальное время
// впереди UTC.
function tzOffsetMs(date, timeZone = REVIEW_TZ) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = dtf.formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// Календарная дата {y, m, d} момента в зоне (без времени).
export function zonedDateParts(date, timeZone = REVIEW_TZ) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = dtf.format(date).split("-").map(Number);
  return { y, m, d };
}

// UTC-инстант локальной полуночи (00:00) заданной календарной даты в зоне.
function zonedMidnightUtc(y, m, d, timeZone = REVIEW_TZ) {
  // Первое приближение — полночь как будто в UTC, затем поправка на сдвиг зоны
  // именно для этого момента (корректно и на границах перевода часов).
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}

// Диапазон «вчера» в Asia/Yerevan: [startUtc, endUtc) — включительно начало,
// исключительно конец (конец = начало сегодняшнего дня). Плюс метка ДД.ММ.ГГГГ.
export function yesterdayRange(now = new Date(), timeZone = REVIEW_TZ) {
  const today = zonedDateParts(now, timeZone);
  // Вчерашняя календарная дата: вычитаем сутки в «календарной» арифметике через
  // UTC-эпоху компонентов (без участия зоны — это чистое смещение даты).
  const y = zonedDateParts(new Date(Date.UTC(today.y, today.m - 1, today.d) - 86400000), "UTC");
  // [начало вчера, начало сегодня) — включительно начало, исключительно конец.
  const startUtc = zonedMidnightUtc(y.y, y.m, y.d, timeZone);
  const endUtc = zonedMidnightUtc(today.y, today.m, today.d, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    startUtc,
    endUtc,
    dateLabel: `${pad(y.d)}.${pad(y.m)}.${y.y}`,
    dateKey: `${y.y}-${pad(y.m)}-${pad(y.d)}`,
  };
}

// Попадает ли момент detected_at во «вчера» (в зоне). Принимает ISO-строку/Date.
export function isYesterday(detectedAt, now = new Date(), timeZone = REVIEW_TZ) {
  if (!detectedAt) return false;
  const t = new Date(detectedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const { startUtc, endUtc } = yesterdayRange(now, timeZone);
  return t >= startUtc.getTime() && t < endUtc.getTime();
}

// ---------------------------------------------------------------------------
// 2. Отбор и классификация тикетов (чистые функции)
// ---------------------------------------------------------------------------

// Источники, которые считаются тикетами бухгалтера. AI сюда не входит.
export const TICKET_SOURCES = ["margarita_review", "sona_review"];

// Статусы, требующие реакции бухгалтера (принять / апелляция). Зеркалит
// ACCOUNTANT_ACTIONABLE соседнего приложения. Тикеты в других статусах уже
// продвинуты по процессу и заново не блокируют.
export const REVIEW_REQUIRED_STATUSES = new Set([
  "new",
  "waiting_for_accountant",
  "returned_to_accountant",
  "appeal_rejected",
]);

// Severity по приоритету: 1 → критично, 2 → средне, иначе → лёгкое.
export function severityOf(priority) {
  const p = Number(priority);
  if (p === 1) return "critical";
  if (p === 2) return "medium";
  return "light";
}

export const SEVERITY_ORDER = ["critical", "medium", "light"];
export const SEVERITY_META = {
  critical: { emoji: "🔴", label: "Критические проблемы" },
  medium: { emoji: "🟠", label: "Средние проблемы" },
  light: { emoji: "🟢", label: "Лёгкие проблемы" },
};

// Актуален ли тикет (не снят как ложное срабатывание / не отброшен). Не зависит
// от даты и владельца — только «жив ли он как тикет».
export function isRelevantTicket(p, opts = {}) {
  if (!p) return false;
  const { excludeTest = true, testPattern = DEFAULT_TEST_PATTERN } = opts;
  if (!TICKET_SOURCES.includes(p.source)) return false;
  if (p.verdict === "not_problematic") return false; // подтверждённое ложное срабатывание
  if (!REVIEW_REQUIRED_STATUSES.has(p.status)) return false;
  if (excludeTest && isTestChat({ chat_name: p.chat_name }, testPattern)) return false;
  return true;
}

// Нормализация имени для сверки владельца (как в scope.js соседнего приложения).
function normName(v) {
  return (v ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

// Принадлежит ли тикет бухгалтеру. Сверяем uuid с accountant_id и нормализованное
// имя с accountant_name/accountant_id (FK между таблицами нет — защищаемся по
// обоим полям).
export function ticketBelongsTo(p, identity) {
  if (!p || !identity) return false;
  const myId = identity.employee_id != null ? String(identity.employee_id) : null;
  if (myId && p.accountant_id != null && String(p.accountant_id) === myId) return true;
  const myName = normName(identity.full_name);
  if (!myName) return false;
  return normName(p.accountant_name) === myName || normName(p.accountant_id) === myName;
}

// Множество problem_id, у которых есть согласие («Принято»).
export function acceptedIds(acks) {
  return new Set((acks || []).map((a) => a.problem_id));
}

// Множество problem_id, по которым бухгалтер подал апелляцию.
export function appealedIds(appeals) {
  return new Set((appeals || []).map((a) => a.problem_id));
}

// Отвечён ли тикет (согласие ИЛИ апелляция). Это единственное определение
// «отвечён» — им пользуются и блокировка, и отчёт.
export function isAnswered(problemId, accepted, appealed) {
  return accepted.has(problemId) || appealed.has(problemId);
}

// Сводка по набору тикетов одного бухгалтера за день: принято / апелляций / без
// ответа + группировка по severity + признак завершённости. Один тикет считается
// РОВНО один раз (по problem_id).
export function summarizeTickets(tickets, acks, appeals) {
  const accepted = acceptedIds(acks);
  const appealed = appealedIds(appeals);

  const seen = new Set();
  let acceptedCount = 0;
  let appealedCount = 0;
  const unanswered = [];
  const bySeverity = { critical: [], medium: [], light: [] };

  for (const t of tickets || []) {
    if (seen.has(t.problem_id)) continue; // без двойного счёта
    seen.add(t.problem_id);
    bySeverity[severityOf(t.priority)].push(t);

    // Апелляция имеет приоритет над согласием в отображении, но одновременно их
    // быть не может (гарантирует БД). Порядок проверки не влияет на суммы.
    if (appealed.has(t.problem_id)) appealedCount += 1;
    else if (accepted.has(t.problem_id)) acceptedCount += 1;
    else unanswered.push(t);
  }

  return {
    total: seen.size,
    accepted: acceptedCount,
    appealed: appealedCount,
    unanswered: unanswered.length,
    unansweredTickets: unanswered,
    bySeverity,
    complete: unanswered.length === 0,
  };
}

// ---------------------------------------------------------------------------
// 3. Текст ежедневной сводки в Telegram (чистые функции)
// ---------------------------------------------------------------------------

export const TELEGRAM_LIMIT = 4096;
// Держим запас под лимитом, чтобы точно не упереться в 4096 и не резать строку.
export const TELEGRAM_SAFE_LIMIT = 3800;

// Экранирование для parse_mode=HTML: только &, <, > (Telegram HTML). Имена чатов
// и тексты проблем — недоверенные, экранируем всегда.
export function escapeHtml(s) {
  return (s ?? "")
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Короткий текст проблемы для строки списка: заголовок или первая часть описания,
// схлопнутый в одну строку и обрезанный.
function shortProblemText(t, max = 90) {
  const raw = (t.problem_title || t.problem_description || t.ai_comment || "").toString();
  const one = raw.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, max - 1).trimEnd() + "…";
}

// Метка чата: «Чат <name>» + Chat ID, если он есть.
function chatLabel(t) {
  const name = (t.chat_name || "").toString().replace(/\s+/g, " ").trim();
  const id = t.contract_id || t.chat_id;
  const base = name ? `Чат ${name}` : id ? `Чат ${id}` : "Чат (без названия)";
  return base;
}

// Одна строка тикета в списке severity: «N. Чат X — краткий текст».
export function ticketLine(index, t) {
  const label = chatLabel(t);
  const text = shortProblemText(t);
  const body = text ? `${label} — ${text}` : label;
  return `${index}. ${escapeHtml(body)}`;
}

// Блок одного бухгалтера (массив строк). Пустые severity-группы показываем как «0»
// последовательно — чтобы формат не «прыгал».
export function accountantBlock(summary, accountantName) {
  const lines = [];
  lines.push(`👤 <b>${escapeHtml(accountantName || "Без ответственного")}</b>`);
  lines.push("");
  lines.push(`Апелляций: ${summary.appealed}`);
  lines.push(`Принято: ${summary.accepted}`);
  lines.push(`Без ответа: ${summary.unanswered}`);

  for (const sev of SEVERITY_ORDER) {
    const items = summary.bySeverity[sev];
    const meta = SEVERITY_META[sev];
    lines.push("");
    lines.push(`${meta.emoji} ${meta.label}: ${items.length}`);
    items.forEach((t, i) => lines.push(ticketLine(i + 1, t)));
  }
  return lines;
}

// Полный отчёт → массив СООБЩЕНИЙ (каждое ≤ лимита). Никогда не режем строку
// тикета пополам: пакуем поблочно и, если блок сам длиннее лимита, разбиваем по
// границам строк.
export function buildTicketReport(perAccountant, dateLabel, platformUrl, limit = TELEGRAM_SAFE_LIMIT) {
  const header = `📋 Отчёт по тикетам за ${escapeHtml(dateLabel)}`;
  const footerLines = platformUrl
    ? ["", `🔗 Дашборд: ${escapeHtml(platformUrl)}`]
    : [];

  // Собираем все логические блоки как массивы строк.
  const blocks = [];
  blocks.push([header]);
  if (!perAccountant.length) {
    blocks.push(["", "За вчера тикетов не было."]);
  }
  for (const a of perAccountant) {
    blocks.push(["", ...accountantBlock(a.summary, a.accountantName)]);
  }
  if (footerLines.length) blocks.push(footerLines);

  // Разбиваем блок, если он один длиннее лимита (по границам строк).
  const splitLongBlock = (blockLines) => {
    const out = [];
    let cur = [];
    let curLen = 0;
    for (const line of blockLines) {
      const add = (cur.length ? 1 : 0) + line.length;
      if (curLen + add > limit && cur.length) {
        out.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(line);
      curLen += (cur.length > 1 ? 1 : 0) + line.length;
    }
    if (cur.length) out.push(cur);
    return out;
  };

  const messages = [];
  let current = [];
  let currentLen = 0;
  const flush = () => {
    if (current.length) messages.push(current.join("\n"));
    current = [];
    currentLen = 0;
  };

  for (const rawBlock of blocks) {
    for (const block of splitLongBlock(rawBlock)) {
      const blockText = block.join("\n");
      const add = (current.length ? 1 : 0) + blockText.length;
      if (currentLen + add > limit && current.length) flush();
      current.push(...(current.length ? [""] : []), ...block);
      // пересчёт длины из фактического содержимого current
      currentLen = current.join("\n").length;
    }
  }
  flush();
  return messages;
}

// ---------------------------------------------------------------------------
// 4. Ввод-вывод (Supabase). Только чтение kk_problems; запись — в рабочие
//    таблицы согласий/апелляций через транзакционную RPC.
// ---------------------------------------------------------------------------

const MAX_APPEAL_COMMENT = 2000;

// Читает актуальные вчерашние тикеты конкретного бухгалтера. Фильтры по
// источнику/статусу/владельцу выполняются в запросе; актуальность/тест-чаты —
// в isRelevantTicket.
export async function fetchYesterdayTicketsFor(identity, { now = new Date(), client } = {}) {
  const db = client || getServiceClient();
  const { startUtc, endUtc } = yesterdayRange(now);
  const { data, error } = await db
    .from("kk_problems")
    .select(
      "problem_id, source, client_name, contract_id, chat_name, chat_link, accountant_name, accountant_id, priority, problem_title, problem_description, ai_comment, detected_at, status, verdict",
    )
    .in("source", TICKET_SOURCES)
    .eq("accountant_id", String(identity.employee_id))
    .gte("detected_at", startUtc.toISOString())
    .lt("detected_at", endUtc.toISOString());
  if (error) throw new Error(`kk_problems query failed: ${error.message}`);
  return (data || []).filter((p) => isRelevantTicket(p) && ticketBelongsTo(p, identity));
}

// Читает согласия/апелляции по списку problem_id. Апелляции — только этого
// бухгалтера (чужие не считаются его ответом).
export async function fetchResponses(problemIds, identity, { client } = {}) {
  const ids = [...new Set(problemIds || [])];
  if (!ids.length) return { acks: [], appeals: [] };
  const db = client || getServiceClient();
  const [ackRes, appRes] = await Promise.all([
    db.from("kk_problem_acknowledgements").select("problem_id, accountant_id").in("problem_id", ids),
    db
      .from("kk_problem_appeals")
      .select("problem_id, accountant_id, status")
      .in("problem_id", ids)
      .eq("accountant_id", String(identity.employee_id)),
  ]);
  if (ackRes.error) throw new Error(`acks query failed: ${ackRes.error.message}`);
  if (appRes.error) throw new Error(`appeals query failed: ${appRes.error.message}`);
  return { acks: ackRes.data || [], appeals: appRes.data || [] };
}

// Состояние блокировки для одного бухгалтера: сводка + список тикетов на разбор.
export async function getGateState(identity, { now = new Date(), client } = {}) {
  const tickets = await fetchYesterdayTicketsFor(identity, { now, client });
  const { acks, appeals } = await fetchResponses(
    tickets.map((t) => t.problem_id),
    identity,
    { client },
  );
  const summary = summarizeTickets(tickets, acks, appeals);
  return {
    tickets,
    ...summary, // total, accepted, appealed, unanswered, unansweredTickets, bySeverity, complete
  };
}

// Проверка комментария апелляции: непусто после trim, не длиннее лимита.
export function validateAppealComment(comment, max = MAX_APPEAL_COMMENT) {
  const trimmed = (comment ?? "").toString().trim();
  if (!trimmed) return { ok: false, error: "comment_required" };
  if (trimmed.length > max) return { ok: false, error: "comment_too_long" };
  return { ok: true, value: trimmed };
}

// Общая проверка перед записью: тикет существует, актуален, принадлежит
// бухгалтеру и относится к вчерашнему дню. Возвращает найденный тикет или ошибку.
export async function loadEligibleTicket(problemId, identity, { now = new Date(), client } = {}) {
  const db = client || getServiceClient();
  const { data, error } = await db
    .from("kk_problems")
    .select(
      "problem_id, source, chat_name, accountant_name, accountant_id, priority, detected_at, status, verdict",
    )
    .eq("problem_id", problemId)
    .maybeSingle();
  if (error) throw new Error(`kk_problems lookup failed: ${error.message}`);
  if (!data) return { ok: false, error: "not_found" };
  if (!ticketBelongsTo(data, identity)) return { ok: false, error: "forbidden" };
  if (!isRelevantTicket(data)) return { ok: false, error: "not_eligible" };
  if (!isYesterday(data.detected_at, now)) return { ok: false, error: "not_in_review_window" };
  return { ok: true, ticket: data };
}

// Записать согласие («Принять»). Валидация + атомарная RPC (взаимоисключение с
// апелляцией и защита от дублей — на стороне БД).
export async function acceptTicket(problemId, identity, { note = null, now = new Date(), client } = {}) {
  const eligible = await loadEligibleTicket(problemId, identity, { now, client });
  if (!eligible.ok) return eligible;
  const db = client || getServiceClient();
  const { data, error } = await db.rpc("kk_ticket_answer", {
    p_problem_id: problemId,
    p_accountant_id: String(identity.employee_id),
    p_accountant_name: identity.full_name || null,
    p_action: "accept",
    p_comment: note,
  });
  if (error) throw new Error(`kk_ticket_answer(accept) failed: ${error.message}`);
  return data;
}

// Записать апелляцию («Подать апелляцию»). Требует непустой комментарий.
export async function appealTicket(problemId, identity, { comment, now = new Date(), client } = {}) {
  const check = validateAppealComment(comment);
  if (!check.ok) return check;
  const eligible = await loadEligibleTicket(problemId, identity, { now, client });
  if (!eligible.ok) return eligible;
  const db = client || getServiceClient();
  const { data, error } = await db.rpc("kk_ticket_answer", {
    p_problem_id: problemId,
    p_accountant_id: String(identity.employee_id),
    p_accountant_name: identity.full_name || null,
    p_action: "appeal",
    p_comment: check.value,
  });
  if (error) throw new Error(`kk_ticket_answer(appeal) failed: ${error.message}`);
  return data;
}

// Данные ежедневной сводки: все вчерашние актуальные тикеты, сгруппированные по
// ответственному бухгалтеру, со сводкой. Та же выборка/подсчёт, что и в блокировке
// (никакой отдельной логики).
export async function buildDailyTicketData({ now = new Date(), client } = {}) {
  const db = client || getServiceClient();
  const { startUtc, endUtc } = yesterdayRange(now);

  // Все вчерашние тикеты (по всем бухгалтерам) с пагинацией.
  const pageSize = 1000;
  let from = 0;
  let all = [];
  for (;;) {
    const { data, error } = await db
      .from("kk_problems")
      .select(
        "problem_id, source, client_name, contract_id, chat_name, chat_link, accountant_name, accountant_id, priority, problem_title, problem_description, ai_comment, detected_at, status, verdict",
      )
      .in("source", TICKET_SOURCES)
      .gte("detected_at", startUtc.toISOString())
      .lt("detected_at", endUtc.toISOString())
      .order("problem_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`kk_problems daily query failed: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  const tickets = all.filter((p) => isRelevantTicket(p));
  const ids = tickets.map((t) => t.problem_id);

  // Согласия и апелляции по всем этим тикетам (без сужения по бухгалтеру: группируем
  // ниже по ответственному тикета).
  let acks = [];
  let appeals = [];
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const [ackRes, appRes] = await Promise.all([
        db.from("kk_problem_acknowledgements").select("problem_id, accountant_id").in("problem_id", chunk),
        db.from("kk_problem_appeals").select("problem_id, accountant_id, status").in("problem_id", chunk),
      ]);
      if (ackRes.error) throw new Error(`acks daily query failed: ${ackRes.error.message}`);
      if (appRes.error) throw new Error(`appeals daily query failed: ${appRes.error.message}`);
      acks = acks.concat(ackRes.data || []);
      appeals = appeals.concat(appRes.data || []);
    }
  }

  return groupDailyByAccountant(tickets, acks, appeals);
}

// Чистая группировка вчерашних тикетов по ответственному бухгалтеру + сводка на
// каждого. Ключ — accountant_id (иначе имя; иначе «Без ответственного»).
export function groupDailyByAccountant(tickets, acks, appeals) {
  const acceptedByProblem = acceptedIds(acks);
  const appealByAcc = new Map(); // problem_id -> Set(accountant_id) подавших апелляцию
  for (const a of appeals || []) {
    if (!appealByAcc.has(a.problem_id)) appealByAcc.set(a.problem_id, new Set());
    appealByAcc.get(a.problem_id).add(String(a.accountant_id));
  }

  const groups = new Map();
  for (const t of tickets || []) {
    const key = (t.accountant_id && String(t.accountant_id)) || normName(t.accountant_name) || "__none__";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        accountantName: t.accountant_name || "Без ответственного",
        tickets: [],
      });
    }
    groups.get(key).tickets.push(t);
  }

  const result = [];
  for (const g of groups.values()) {
    // Апелляции этого бухгалтера: problem_id, где accountant_id входит в набор
    // подавших (для сводки берём апелляцию именно ответственного тикета).
    const myAppeals = g.tickets
      .filter((t) => {
        const set = appealByAcc.get(t.problem_id);
        if (!set) return false;
        return g.key !== "__none__" ? set.has(g.key) : set.size > 0;
      })
      .map((t) => ({ problem_id: t.problem_id }));
    const myAcks = g.tickets
      .filter((t) => acceptedByProblem.has(t.problem_id))
      .map((t) => ({ problem_id: t.problem_id }));
    const summary = summarizeTickets(g.tickets, myAcks, myAppeals);
    result.push({ key: g.key, accountantName: g.accountantName, summary });
  }
  // Стабильный порядок: по имени бухгалтера.
  result.sort((a, b) => a.accountantName.localeCompare(b.accountantName, "ru"));
  return result;
}
