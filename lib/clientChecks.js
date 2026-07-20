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

// «Рядом с именем есть номер договора» — эвристика владельца процесса: если в
// идентификаторе клиента встречается число из 4+ цифр (номер договора, напр.
// B-4233 / 4662 / TG-5080353975), считаем, что HVHH у клиента по сути ЕСТЬ
// (просто не перенесён в таблицу Agreements), и такую строку НЕ помечаем как
// «нет HVHH». Строки без такого номера (напр. SQA-VONABI) остаются в списке.
const AGREEMENT_NUMBER_RE = /\d{4,}/;
const hasAgreementNumber = (row) =>
  AGREEMENT_NUMBER_RE.test(
    [row.agr_no, row.name_agr, row.name_tax, row.chat_name]
      .map((v) => (v == null ? "" : String(v)))
      .join(" "),
  );
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

    // 2) Нет HVHH в Agreements — поле hvhh пустое И рядом с именем нет номера
    // договора (4+ цифр): наличие номера договора трактуем как «HVHH есть».
    if (isBlank(row.hvhh) && !hasAgreementNumber(row)) {
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
  return computeClientChecks(all);
}
