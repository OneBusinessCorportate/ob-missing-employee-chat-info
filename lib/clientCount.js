// Контроль количества клиентов (client-count control / reconciliation).
//
// Задача: свести ВСЕ компании из ВСЕХ источников в одну таблицу сравнения и
// ответить на вопросы:
//   1) Видеть общее количество записей везде (итоги по каждому источнику);
//   2) Разложить, сколько из них исключений / неактивных;
//   3) Сравнить активных и тех, кого «непонятно / не можем найти» (в т.ч. те,
//      кто общается через mail или WhatsApp, а не Telegram);
//   4) Собрать по каждому проблемному клиенту план действий (где искать / что
//      делать) и короткое промежуточное сообщение для Гарри;
//   5) Через выгрузку аккаунта Эмилии / менеджеров показать все чаты, которые
//      есть на аккаунте, но в которых НЕТ бота.
//
// Источники (снимки Excel лежат в data/recon/*.jsonl, живые данные — из OB FAQ
// Supabase). «Agr.list = ИНН бухгалтеров (вместе с исключениями)» — мастер-список
// компаний берём из листа Agreements (все компании, включая неактивных и
// исключения), и обогащаем остальными источниками по HVHH → № договора → имени.
//
// Ничего никуда не пишем — только читаем реальные данные. Чистая функция
// computeClientCount тестируется без Supabase и без файлов.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getServiceClient } from "./supabaseServer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data", "recon");

// ---- нормализация --------------------------------------------------------
const isBlank = (v) => v == null || String(v).trim() === "";
const clean = (v) => (isBlank(v) ? "" : String(v).replace(/\s+/g, " ").trim());
export const normHvhh = (v) => (isBlank(v) ? "" : String(v).replace(/\D/g, ""));
export const normAgr = (v) =>
  isBlank(v) ? "" : String(v).replace(/\.0$/, "").trim();
export const normName = (v) =>
  isBlank(v)
    ? ""
    : String(v)
        .toLowerCase()
        .replace(/[«»"'`]/g, "")
        .replace(/[^0-9a-zа-яё԰-֏]+/gi, "");

const isActiveStatus = (s) => clean(s).toLowerCase() === "active";
const isInactiveStatus = (s) => clean(s).toLowerCase() === "inactive";
const isOnceStatus = (s) => clean(s).toLowerCase() === "once";
const isBadDebtStatus = (s) => clean(s).toLowerCase().includes("bad debt");

// Канал общения по значению ссылки на чат (Chat LINK из листа «Чаты»).
export function chatChannel(link) {
  const l = clean(link).toLowerCase();
  if (!l) return "none";
  if (l.includes("вотс") || l.includes("ватс") || l.includes("whats") || l.includes("wa.me"))
    return "whatsapp";
  if (l.includes("не работаем") || l.includes("не раб")) return "not_working";
  if (l.includes("t.me") || l.includes("telegram")) return "telegram";
  if (l.includes("@") || l.includes("mail") || l.includes("gmail") || l.includes("почт"))
    return "mail";
  if (l.startsWith("http")) return "telegram";
  return "other_text";
}

// Статус наличия бота по выгрузке аккаунта (лист «Chats without bot»).
export function botStatusFromIssue(issueType, botExists) {
  const s = clean(issueType).toLowerCase();
  if (s === "ok") return "ok";
  if (s.includes("нет бота")) return "no_bot";
  if (s.includes("once")) return "once";
  if (s.includes("unknown")) return "unknown";
  if (clean(botExists).toLowerCase() === "true") return "ok";
  if (clean(botExists).toLowerCase() === "false") return "no_bot";
  return "unlisted";
}

// ---- чистое ядро сведения ------------------------------------------------
//
// Принимает уже загруженные массивы источников и (опционально) живые данные из
// Supabase. Возвращает полный payload для дашборда.
export function computeClientCount(sources = {}, live = {}) {
  const agreements = sources.agreements || [];
  const refuseniks = sources.refuseniks || [];
  const chatsSheet = sources.chatsSheet || [];
  const chatsWithoutBot = sources.chatsWithoutBot || [];
  const onebusiness = sources.onebusiness || [];
  const nameExceptions = sources.nameExceptions || [];
  const mqaLive = live.mqaActive || [];

  // Карта наличия бота: нормализованное имя чата -> статус бота.
  const botByChat = new Map();
  for (const r of chatsWithoutBot) {
    const key = normName(r.chat_name);
    if (key) botByChat.set(key, botStatusFromIssue(r.issue_type, r.bot_exists));
  }

  // Набор имён-исключений (лист Exceptions: Tabby / Agency и т.п.).
  const exceptionNames = nameExceptions
    .map((r) => normName(r.name))
    .filter(Boolean);
  const isNameException = (name) => {
    const n = normName(name);
    return n ? exceptionNames.some((e) => e && (n === e || n.includes(e))) : false;
  };

  // Собираем ВСЕ строки из всех источников в единый список записей, затем
  // склеиваем их в компании через union-find по СИЛЬНЫМ идентификаторам:
  // HVHH и № договора. Имя для склейки НЕ используем (два разных клиента могут
  // называться одинаково, а один клиент — иметь два договора). Только записи
  // вообще без HVHH и без № договора склеиваем по нормализованному имени.
  const records = [];
  const push = (src, hvhh, agr_no, name, extra) => {
    const rec = {
      src,
      hvhh: normHvhh(hvhh),
      agr_no: normAgr(agr_no),
      name: clean(name),
      name_key: normName(name),
      ...extra,
    };
    // Пропускаем строки-мусор, которые нечем идентифицировать: нет HVHH,
    // нет № договора и пустое имя (напр. плейсхолдеры «-»).
    if (!rec.hvhh && !rec.agr_no && !rec.name_key) return;
    records.push(rec);
  };

  for (const r of agreements)
    push("agreements", r.hvhh, r.agr_no, r.company, { status: clean(r.status) });
  for (const r of onebusiness)
    push("onebusiness", r.hvhh, r.agr_no, r.client_name || r.tax_name, {
      status: clean(r.status),
      accountant: clean(r.accountant),
    });
  for (const r of chatsSheet)
    push("chats_sheet", r.hvhh, r.agr_no, r.name_agr || r.name_tax, {
      status: clean(r.status),
      chat_name: clean(r.chat_name),
      chat_link: clean(r.chat_link),
    });
  for (const r of mqaLive)
    push("mqa", r.hvhh, r.agr_no, r.name_agr || r.name_tax, {
      status: clean(r.status) || "Active",
      accountant: clean(r.accountant),
      manager: clean(r.manager),
      chat_name: clean(r.chat_name),
      chat_link: clean(r.chat_link),
    });
  for (const r of refuseniks)
    push("refuseniks", "", r.agr_no, r.company, {
      is_refusenik: true,
      refusenik_reason: clean(r.reason) || clean(r.problem_type),
    });

  // union-find по индексам записей
  const parent = records.map((_, i) => i);
  const findRoot = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = findRoot(a);
    const rb = findRoot(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const firstByHvhh = new Map();
  const firstByAgr = new Map();
  const firstByName = new Map(); // только для записей без HVHH и без № договора
  records.forEach((r, i) => {
    if (r.hvhh) {
      if (firstByHvhh.has(r.hvhh)) union(i, firstByHvhh.get(r.hvhh));
      else firstByHvhh.set(r.hvhh, i);
    }
    if (r.agr_no) {
      if (firstByAgr.has(r.agr_no)) union(i, firstByAgr.get(r.agr_no));
      else firstByAgr.set(r.agr_no, i);
    }
    if (!r.hvhh && !r.agr_no && r.name_key) {
      if (firstByName.has(r.name_key)) union(i, firstByName.get(r.name_key));
      else firstByName.set(r.name_key, i);
    }
  });

  // Сводим записи каждой компоненты в одну компанию.
  const compByRoot = new Map();
  const companies = [];
  records.forEach((r, i) => {
    const root = findRoot(i);
    let co = compByRoot.get(root);
    if (!co) {
      co = {
        hvhh: "",
        agr_no: "",
        name: "",
        name_key: "",
        sources: new Set(),
        status: {},
        accountant: "",
        manager: "",
        chat_name: "",
        chat_link: "",
        chat_channel: "none",
        bot_status: "n_a",
        is_refusenik: false,
        refusenik_reason: "",
        is_name_exception: false,
      };
      compByRoot.set(root, co);
      companies.push(co);
    }
    co.sources.add(r.src);
    if (r.status) co.status[r.src] = r.status;
    if (!co.hvhh && r.hvhh) co.hvhh = r.hvhh;
    if (!co.agr_no && r.agr_no) co.agr_no = r.agr_no;
    if (!co.name && r.name) {
      co.name = r.name;
      co.name_key = r.name_key;
    }
    if (!co.accountant && r.accountant) co.accountant = r.accountant;
    if (!co.manager && r.manager) co.manager = r.manager;
    if (r.chat_name && !co.chat_name) co.chat_name = r.chat_name;
    if (r.chat_link && (isBlank(co.chat_link) || co.chat_channel === "none")) {
      co.chat_link = r.chat_link;
      co.chat_channel = chatChannel(r.chat_link);
    }
    if (r.is_refusenik) {
      co.is_refusenik = true;
      if (r.refusenik_reason) co.refusenik_reason = r.refusenik_reason;
    }
    if (r.name && isNameException(r.name)) co.is_name_exception = true;
  });

  // Наличие бота — по названию чата из выгрузки аккаунта.
  for (const co of companies) {
    if (co.chat_name) {
      const bot = botByChat.get(normName(co.chat_name));
      if (bot) co.bot_status = bot;
    }
  }

  // ---- классификация каждой компании ------------------------------------
  const anyStatus = (co, pred) => Object.values(co.status).some(pred);
  for (const co of companies) {
    const active = anyStatus(co, isActiveStatus);
    const inactive = anyStatus(co, isInactiveStatus);
    const once = anyStatus(co, isOnceStatus);
    const badDebt = anyStatus(co, isBadDebtStatus);

    co.is_exception = co.is_refusenik || co.is_name_exception;
    // Эффективно активная компания: где-то активна и НЕ отказник/исключение.
    co.effective_active = active && !co.is_exception;

    if (co.is_refusenik) co.status_class = "refusenik";
    else if (co.is_name_exception) co.status_class = "exception";
    else if (co.effective_active) co.status_class = "active";
    else if (badDebt) co.status_class = "bad_debts";
    else if (once) co.status_class = "once";
    else if (inactive) co.status_class = "inactive";
    else co.status_class = "unknown";

    // Ведёрко по чату — только для эффективно активных.
    if (!co.effective_active) {
      co.bucket = "not_active";
    } else if (co.chat_channel === "telegram") {
      if (co.bot_status === "ok") co.bucket = "in_bot";
      else if (co.bot_status === "no_bot") co.bucket = "telegram_no_bot";
      else co.bucket = "chat_unclear"; // once / unknown / unlisted / n_a
    } else if (co.chat_channel === "whatsapp" || co.chat_channel === "mail") {
      co.bucket = "other_channel";
    } else {
      // none / not_working / other_text / нет строки в листе «Чаты»
      co.bucket = "not_found";
    }

    co.for_harry =
      co.effective_active &&
      (co.bucket === "other_channel" ||
        co.bucket === "not_found" ||
        co.bucket === "chat_unclear" ||
        co.bucket === "telegram_no_bot");
    co.action = actionPlan(co);
  }

  // ---- итоги по источникам (раздел 1 + 2) --------------------------------
  const countBy = (rows, pred) => rows.reduce((n, r) => n + (pred(r) ? 1 : 0), 0);
  const sourceTotals = [
    {
      key: "agreements",
      label: "Agreements (мастер-список, xlsx)",
      total: agreements.length,
      active: countBy(agreements, (r) => isActiveStatus(r.status)),
      inactive: countBy(
        agreements,
        (r) => isInactiveStatus(r.status) || isBadDebtStatus(r.status),
      ),
    },
    {
      key: "onebusiness",
      label: "One Business (основные данные, xlsx)",
      total: onebusiness.length,
      active: countBy(onebusiness, (r) => isActiveStatus(r.status)),
      inactive: countBy(
        onebusiness,
        (r) => isInactiveStatus(r.status) || isOnceStatus(r.status),
      ),
    },
    {
      key: "chats_sheet",
      label: "Чаты (привязка к Telegram, xlsx)",
      total: chatsSheet.length,
      active: countBy(chatsSheet, (r) => isActiveStatus(r.status)),
      inactive: countBy(chatsSheet, (r) => isInactiveStatus(r.status)),
    },
    {
      key: "chats_without_bot",
      label: "Chats without bot (выгрузка аккаунта, xlsx)",
      total: chatsWithoutBot.length,
      active: countBy(chatsWithoutBot, (r) => botStatusFromIssue(r.issue_type, r.bot_exists) === "ok"),
      inactive: countBy(chatsWithoutBot, (r) => botStatusFromIssue(r.issue_type, r.bot_exists) === "no_bot"),
    },
    {
      key: "refuseniks",
      label: "Отказники (ушли/исключены, xlsx)",
      total: refuseniks.length,
      active: 0,
      inactive: refuseniks.length,
    },
    {
      key: "mqa_live",
      label: "Supabase v_mqa_active (живые активные клиенты)",
      total: mqaLive.length,
      active: mqaLive.length,
      inactive: 0,
    },
    {
      key: "chats_live",
      label: "Supabase chats (чаты в боте, активные)",
      total: live.chatsActive != null ? live.chatsActive : null,
      active: live.chatsActive != null ? live.chatsActive : null,
      inactive:
        live.chatsTotal != null && live.chatsActive != null
          ? live.chatsTotal - live.chatsActive
          : null,
    },
  ];

  // Разбивка мастер-универсума (все компании из всех источников).
  const byClass = {};
  for (const co of companies) byClass[co.status_class] = (byClass[co.status_class] || 0) + 1;

  // Ведёрки среди эффективно активных (раздел 3: активные vs не можем найти).
  const activeCompanies = companies.filter((c) => c.effective_active);
  const buckets = {
    in_bot: 0,
    telegram_no_bot: 0,
    other_channel: 0,
    chat_unclear: 0,
    not_found: 0,
  };
  for (const co of activeCompanies) buckets[co.bucket] = (buckets[co.bucket] || 0) + 1;

  // План действий (раздел 4) — проблемные активные, отсортированы по важности.
  const bucketRank = { not_found: 0, other_channel: 1, telegram_no_bot: 2, chat_unclear: 3 };
  const actionRows = activeCompanies
    .filter((c) => c.for_harry)
    .map((c) => publicCompany(c))
    .sort(
      (a, b) =>
        (bucketRank[a.bucket] ?? 9) - (bucketRank[b.bucket] ?? 9) ||
        (a.name || "").localeCompare(b.name || "", "ru"),
    );

  // Раздел 5: чаты на аккаунте (Эмилия / менеджеры), где НЕТ бота.
  const managerChatsNoBot = chatsWithoutBot
    .filter((r) => botStatusFromIssue(r.issue_type, r.bot_exists) === "no_bot")
    .map((r) => {
      const chat_name = clean(r.chat_name);
      const chat_id = clean(r.chat_id) || null;
      return {
        chat_name,
        chat_id,
        chat_link: clean(r.chat_link) || null,
        // Эти чаты без HVHH — добавляем ID к названию, чтобы их можно было
        // однозначно найти по названию (например, в CSV или при добавлении бота).
        label: chat_id ? `${chat_name} [ID ${chat_id}]` : chat_name,
      };
    })
    .sort((a, b) => (a.chat_name || "").localeCompare(b.chat_name || "", "ru"));
  const managerChatsUnclear = chatsWithoutBot.filter((r) => {
    const s = botStatusFromIssue(r.issue_type, r.bot_exists);
    return s === "once" || s === "unknown";
  }).length;

  // Полная таблица сравнения (главная цель) — все компании из всех источников.
  const allCompanies = companies
    .map(publicCompany)
    .sort((a, b) => (a.name || a.hvhh || "").localeCompare(b.name || b.hvhh || "", "ru"));

  const summaryForHarry = buildHarryMessage(buckets, managerChatsNoBot.length, byClass);

  return {
    generated_at: null, // проставляет вызывающий
    source_totals: sourceTotals,
    universe: {
      total: companies.length,
      by_class: byClass,
      active: activeCompanies.length,
      exceptions:
        (byClass.refusenik || 0) +
        (byClass.exception || 0) +
        (byClass.inactive || 0) +
        (byClass.once || 0) +
        (byClass.bad_debts || 0) +
        (byClass.unknown || 0),
    },
    buckets,
    action_rows: actionRows,
    manager_chats_no_bot: managerChatsNoBot,
    manager_chats_unclear: managerChatsUnclear,
    all_companies: allCompanies,
    harry_message: summaryForHarry,
  };
}

// План действий по компании: где искать / что делать.
function actionPlan(co) {
  const hvhh = co.hvhh ? `HVHH ${co.hvhh}` : "";
  const agr = co.agr_no ? `договор ${co.agr_no}` : "";
  const ident = [hvhh, agr].filter(Boolean).join(" / ");
  switch (co.bucket) {
    case "in_bot":
      return { where: "Чат в Telegram, бот на месте", what: "Действий не требуется" };
    case "telegram_no_bot":
      return {
        where: `Telegram-чат есть в выгрузке аккаунта («${co.chat_name}»), но бота в нём нет`,
        what: `Добавить бота в чат; проверить ссылку: ${co.chat_link || "—"}`,
      };
    case "other_channel":
      return {
        where: `Общение вне Telegram (${co.chat_channel === "whatsapp" ? "WhatsApp" : "mail"}): ${co.chat_link || "—"}`,
        what: "Создать/перенести в Telegram-чат и добавить бота; передать Гарри",
      };
    case "chat_unclear":
      return {
        where: `Статус чата непонятен (${co.bot_status}); ${co.chat_link || "нет ссылки"}`,
        what: `Проверить, существует ли чат (${ident || "по имени"}); уточнить у менеджера`,
      };
    case "not_found":
      return {
        where: "Чат не найден ни в одном источнике",
        what: `Найти по ${ident || "имени"}; проверить mail/WhatsApp; написать Гарри`,
      };
    default:
      return { where: "", what: "" };
  }
}

// Название с ID для записей БЕЗ HVHH: чтобы чат/компанию можно было однозначно
// найти по имени, добавляем к названию его идентификатор (№ договора). Если HVHH
// есть — идентификатор уже виден в своей колонке, название не трогаем.
export function labelWithId(co) {
  const rawName = clean(co.name);
  // Если названия нет — показываем сам идентификатор (без дублирования).
  if (!rawName) return co.hvhh ? `HVHH ${co.hvhh}` : co.agr_no ? `№${co.agr_no}` : "—";
  // Есть HVHH — идентификатор уже виден в своей колонке, название не трогаем.
  if (co.hvhh) return rawName;
  // Нет HVHH — добавляем к названию № договора, чтобы было чем идентифицировать.
  return co.agr_no ? `${rawName} [№${co.agr_no}]` : rawName;
}

// Компактное представление компании для API/таблицы.
function publicCompany(co) {
  return {
    name: co.name || null,
    label: labelWithId(co),
    hvhh: co.hvhh || null,
    agr_no: co.agr_no || null,
    accountant: co.accountant || null,
    manager: co.manager || null,
    status_class: co.status_class,
    status: co.status,
    sources: Array.from(co.sources),
    chat_name: co.chat_name || null,
    chat_link: co.chat_link || null,
    chat_channel: co.chat_channel,
    bot_status: co.bot_status,
    bucket: co.bucket,
    is_exception: co.is_exception,
    is_refusenik: co.is_refusenik,
    refusenik_reason: co.refusenik_reason || null,
    for_harry: Boolean(co.for_harry),
    action: co.action,
  };
}

// Короткое промежуточное сообщение для Гарри (готово к копированию).
function buildHarryMessage(buckets, noBotCount, byClass) {
  const lines = [
    "Контроль количества клиентов — промежуточно:",
    `• Активных клиентов всего: ${
      buckets.in_bot +
      buckets.telegram_no_bot +
      buckets.other_channel +
      buckets.chat_unclear +
      buckets.not_found
    }`,
    `• В боте (ОК): ${buckets.in_bot}`,
    `• Telegram-чат есть, но бота нет: ${buckets.telegram_no_bot}`,
    `• Общение через WhatsApp/mail: ${buckets.other_channel}`,
    `• Статус чата непонятен: ${buckets.chat_unclear}`,
    `• Не можем найти чат: ${buckets.not_found}`,
    `• Чаты на аккаунте без бота (добавить бота): ${noBotCount}`,
    `• Исключения/неактивные (отказники + inactive + прочее): ${
      (byClass.refusenik || 0) +
      (byClass.exception || 0) +
      (byClass.inactive || 0) +
      (byClass.once || 0) +
      (byClass.bad_debts || 0)
    }`,
  ];
  return lines.join("\n");
}

// ---- загрузка снимков и живых данных ------------------------------------
function readJsonl(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function loadSnapshots() {
  return {
    agreements: readJsonl("agreements.jsonl"),
    refuseniks: readJsonl("refuseniks.jsonl"),
    chatsSheet: readJsonl("chats_sheet.jsonl"),
    chatsWithoutBot: readJsonl("chats_without_bot.jsonl"),
    onebusiness: readJsonl("onebusiness.jsonl"),
    nameExceptions: readJsonl("name_exceptions.jsonl"),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Живые данные из Supabase (OB FAQ): активные клиенты v_mqa_active + счётчики
// чатов в боте. Best-effort: сбой не должен ронять дашборд — тогда считаем
// только по снимкам xlsx.
export async function fetchLive({ attempts = 3, baseDelayMs = 400 } = {}) {
  const client = getServiceClient();
  const live = { mqaActive: [], chatsActive: null, chatsTotal: null };

  // v_mqa_active (страницами)
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    let data = null;
    let error = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      ({ data, error } = await client
        .from("v_mqa_active")
        .select("agr_no, hvhh, name_agr, name_tax, status, chat_name, chat_link, accountant, manager")
        .range(from, from + pageSize - 1));
      if (!error) break;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    if (error) throw new Error(`v_mqa_active read failed: ${error.message}`);
    live.mqaActive = live.mqaActive.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  // Счётчики чатов в боте.
  const { count: activeCount } = await client
    .from("chats")
    .select("chat_id", { count: "exact", head: true })
    .eq("is_active", true)
    .eq("excluded_from_qa", false);
  const { count: totalCount } = await client
    .from("chats")
    .select("chat_id", { count: "exact", head: true });
  live.chatsActive = activeCount ?? null;
  live.chatsTotal = totalCount ?? null;
  return live;
}

// Полный расчёт для дашборда: снимки xlsx + живые данные Supabase.
export async function getClientCount() {
  const sources = loadSnapshots();
  let live = { mqaActive: [], chatsActive: null, chatsTotal: null };
  let liveError = null;
  try {
    live = await fetchLive();
  } catch (err) {
    liveError = err.message;
    console.error("[clientCount] live fetch failed:", err.message);
  }
  const result = computeClientCount(sources, live);
  result.generated_at = new Date().toISOString();
  result.live_error = liveError;
  return result;
}
