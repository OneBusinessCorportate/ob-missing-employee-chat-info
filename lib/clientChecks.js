// Ежедневная проверка клиентов/чатов по данным Agreements (kk-сопровождение).
//
// Источник — таблица public.mqa_chats (та же, что стоит за вью
// public.v_mqa_active для status='Active'): одна строка на клиента/договор со
// всеми нужными полями в одном месте, поэтому НЕ требуется неточное
// сопоставление между разными таблицами:
//   agr_no    — номер договора (agreement id / contract id)
//   hvhh      — ИНН клиента (ՀՎՀՀ)
//   name_agr  — название по договору (клиент / компания)
//   name_tax  — название по налоговой
//   status    — статус клиента (Active / Inactive)
//   chat_name — название Telegram-чата
//   chat_link — ссылка на Telegram-чат (пусто => чата нет)
//   accountant, manager — ответственные (как заполнено в Agreements)
//
// Считаем три метрики ТОЛЬКО по активным клиентам (status='Active' — это и есть
// активные месячные клиенты сопровождения):
//   1) Чаты без ответственных — нет бухгалтера ИЛИ менеджера;
//   2) Нет HVHH в Agreements — поле hvhh пустое;
//   3) Нет чатов у активных месячных клиентов — поле chat_link пустое.
//
// Ничего не пишем — только читаем реальные данные. Чистая функция
// computeClientChecks тестируется без Supabase.

import { getServiceClient } from "./supabaseServer.js";

// Источник — read-only вью public.v_mqa_active (только активные клиенты,
// status='Active'). Читаем именно ВЬЮ, а не саму таблицу mqa_chats: на таблице
// включён RLS без политик, поэтому прямой SELECT возвращает данные ТОЛЬКО под
// service_role-ключом, а под обычным ключом — пусто. Вью же (security definer,
// принадлежит postgres) обходит RLS и отдаёт строки под любым ключом проекта —
// ровно так же, как getProblemChats читает свою вью. Это убирает молчаливый
// сбой доп. метрик, когда крон запущен не с service_role-ключом.
const SOURCE_VIEW = "v_mqa_active";

const isBlank = (v) => v == null || String(v).trim() === "";

// Схлопываем внутренние переносы строк/повторные пробелы в один пробел: в
// источнике встречаются многострочные значения (напр. «ИМЯ\nООО»), а сообщение
// в Telegram держим по одной строке на клиента.
const trimOrNull = (v) =>
  isBlank(v) ? null : String(v).replace(/\s+/g, " ").trim();

// Человекочитаемая метка клиента для деталей и коротких списков. Берём первое
// непустое из: название по договору → по налоговой → название чата → № договора
// → HVHH. Если ничего нет — клиента идентифицировать нельзя (см. Needs review).
export function clientLabel(row) {
  return (
    trimOrNull(row.name_agr) ||
    trimOrNull(row.name_tax) ||
    trimOrNull(row.chat_name) ||
    (trimOrNull(row.agr_no) ? `Договор ${String(row.agr_no).trim()}` : null) ||
    (trimOrNull(row.hvhh) ? `HVHH ${String(row.hvhh).trim()}` : null)
  );
}

// Pure reducer: из строк mqa_chats (активных) формирует три списка проблемных
// клиентов, счётчики и отдельный список Needs review. Без побочных эффектов.
//
// Needs review: если клиента невозможно точно идентифицировать (нет ни названия,
// ни № договора, ни HVHH, ни названия чата) — не подмешиваем его в цифры, а
// откладываем на ручную проверку, чтобы не считать «мимо» и не выдумывать.
export function computeClientChecks(rows) {
  const all = rows || [];

  const noResponsible = [];
  const noHvhh = [];
  const noChat = [];
  const needsReview = [];

  for (const row of all) {
    const client = clientLabel(row);
    if (!client) {
      needsReview.push({
        reason: "no_identifier",
        agr_no: trimOrNull(row.agr_no),
        chat_link: trimOrNull(row.chat_link),
        status: trimOrNull(row.status),
        source: "Agreements (mqa_chats)",
      });
      continue;
    }

    // 1) Чаты без ответственных — нет бухгалтера ИЛИ менеджера.
    const accMissing = isBlank(row.accountant);
    const mgrMissing = isBlank(row.manager);
    if (accMissing || mgrMissing) {
      noResponsible.push({
        client,
        agr_no: trimOrNull(row.agr_no),
        hvhh: trimOrNull(row.hvhh),
        chat_name: trimOrNull(row.chat_name),
        chat_link: trimOrNull(row.chat_link),
        missing:
          accMissing && mgrMissing ? "both" : accMissing ? "accountant" : "manager",
        accountant: trimOrNull(row.accountant),
        manager: trimOrNull(row.manager),
        status: trimOrNull(row.status),
        source: "Agreements (mqa_chats)",
      });
    }

    // 2) Нет HVHH в Agreements — реальное поле hvhh (ИНН/ՀՎՀՀ) пустое. Проверяем
    // именно сам HVHH: номер договора (B-4233 и т.п.) больше НЕ считается за
    // «HVHH есть». Реальные значения HVHH перенесены в mqa_chat_corrections из
    // колонки HVHH (Agreements / налоговая), см. sql/009.
    if (isBlank(row.hvhh)) {
      noHvhh.push({
        client,
        agr_no: trimOrNull(row.agr_no),
        // Ссылка на чат (если она есть в Agreements) — чтобы в UI можно было
        // сразу открыть чат клиента, у которого не хватает только HVHH.
        chat_link: trimOrNull(row.chat_link),
        accountant: trimOrNull(row.accountant),
        manager: trimOrNull(row.manager),
        status: trimOrNull(row.status),
        comment: null, // отдельного поля комментария/причины в источнике нет
        source: "Agreements (mqa_chats)",
      });
    }

    // 3) Нет чатов у активных месячных клиентов — нет ссылки на Telegram-чат.
    if (isBlank(row.chat_link)) {
      noChat.push({
        client,
        hvhh: trimOrNull(row.hvhh),
        accountant: trimOrNull(row.accountant),
        manager: trimOrNull(row.manager),
        status: trimOrNull(row.status),
        client_type: "monthly",
        missing: "Telegram chat",
        source: "Agreements (mqa_chats)",
      });
    }
  }

  const counts = {
    no_responsible: noResponsible.length,
    no_hvhh: noHvhh.length,
    no_chat: noChat.length,
    needs_review: needsReview.length,
    total_active: all.length,
  };

  return { noResponsible, noHvhh, noChat, needsReview, counts };
}

// Read-only вью чатов, которых физически нет в Telegram (ручная отметка QA,
// таблица public.nonexistent_chats). Такие чаты убраны из чек-листа
// (chats.excluded_from_qa=true), но их нужно показать в блоке «нет чатов у
// активных клиентов» — как и клиентов Agreements без ссылки на чат.
const NONEXISTENT_VIEW = "v_nonexistent_chats";

// Pure: превращает строку v_nonexistent_chats в строку списка «нет чатов»
// того же вида, что и клиенты Agreements без чата (см. computeClientChecks).
export function nonexistentToNoChat(row) {
  const name = trimOrNull(row.chat_name) || `Chat ${row.chat_id}`;
  return {
    client: name,
    hvhh: null,
    accountant: null,
    manager: null,
    status: "Active",
    client_type: "monthly",
    missing: "Telegram chat",
    chat_id: row.chat_id != null ? String(row.chat_id) : null,
    note: trimOrNull(row.note),
    source: "Ручная отметка: чат не существует",
  };
}

// Pure: добавляет чаты «не существует» в список noChat и обновляет счётчик.
// Дубли по chat_id отбрасываем, чтобы повтор не удваивал цифру.
export function mergeNonexistentNoChat(result, nonexistentRows) {
  const rows = nonexistentRows || [];
  if (!rows.length) return result;
  const seen = new Set(
    (result.noChat || []).map((r) => (r.chat_id != null ? String(r.chat_id) : null)),
  );
  const extra = [];
  for (const row of rows) {
    const id = row.chat_id != null ? String(row.chat_id) : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    extra.push(nonexistentToNoChat(row));
  }
  if (!extra.length) return result;
  const noChat = result.noChat.concat(extra);
  return {
    ...result,
    noChat,
    counts: { ...result.counts, no_chat: noChat.length },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Читает активных клиентов из mqa_chats (с пагинацией на случай роста) и сводит
// их в три метрики. Только чтение — ничего не меняет в таблицах.
//
// Каждую страницу читаем с повторами и экспоненциальной задержкой: транзиентная
// ошибка Supabase (сеть/таймаут) не должна «съедать» доп. метрики в сводке —
// иначе сообщение молча выглядит как старый формат без этих цифр.
export async function getClientChecks({ attempts = 3, baseDelayMs = 500 } = {}) {
  const client = getServiceClient();
  const pageSize = 1000;
  let from = 0;
  let all = [];
  for (;;) {
    let data = null;
    let error = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      ({ data, error } = await client
        .from(SOURCE_VIEW)
        .select(
          "agr_no, hvhh, name_agr, name_tax, status, chat_name, chat_link, accountant, manager",
        )
        .eq("status", "Active")
        .order("agr_no", { ascending: true })
        .range(from, from + pageSize - 1));
      if (!error) break;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  const result = computeClientChecks(all);

  // Добавляем к «нет чатов» вручную отмеченные несуществующие чаты. Best-effort:
  // сбой этого чтения не должен ронять основные метрики Agreements — тогда просто
  // не добавляем несуществующие чаты (и не завышаем счётчик).
  let nonexistent = [];
  try {
    const { data, error } = await client
      .from(NONEXISTENT_VIEW)
      .select("chat_id, chat_name, note")
      .order("chat_name", { ascending: true });
    if (error) throw new Error(error.message);
    nonexistent = data || [];
  } catch (err) {
    console.error("[clientChecks] nonexistent chats read failed:", err.message);
  }
  return mergeNonexistentNoChat(result, nonexistent);
}
