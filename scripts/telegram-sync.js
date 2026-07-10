// Синхронизация присутствия ответственных из Telegram через ПОЛЬЗОВАТЕЛЬСКИЙ
// аккаунт (MTProto, вход по номеру телефона) — а не через бота.
//
// Что делает:
//   1. Входит в Telegram по сохранённой строке сессии (TELEGRAM_SESSION),
//      полученной через `npm run telegram-login`.
//   2. Перебирает все диалоги-группы, в которых состоит аккаунт.
//   3. Для каждой группы получает ПОЛНЫЙ список участников (то, чего не может
//      бот) и сопоставляет их со справочником employees (по Telegram id / @username).
//   4. Пишет достоверные строки присутствия is_present=true в
//      public.chat_employee_presence (upsert по (chat_id, employee_id)).
//
// Это чинит ложные вердикты «нет ответственного», которые возникали из-за
// ошибок Bot API (member not found / chat not found / bot was kicked).
//
// Обязательные env:
//   TELEGRAM_API_ID, TELEGRAM_API_HASH  - с my.telegram.org
//   TELEGRAM_SESSION                    - строка сессии (см. telegram-login)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Необязательные:
//   DRY_RUN=1          - ничего не писать, только показать, что нашли
//   SYNC_ALL_CHATS=1   - писать присутствие для всех групп аккаунта, а не только
//                        для чатов из public.chats (по умолчанию — только для
//                        активных, не исключённых из QA чатов)
//   SYNC_CHAT_LIMIT=N  - обработать не более N групп (для отладки)

import { createClient } from "@supabase/supabase-js";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { getPeerId } from "telegram/Utils.js";
import {
  buildEmployeeIndex,
  computePresenceForChat,
} from "../lib/telegramSync.js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://fjsogozwseqoxgddjeig.supabase.co";
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const sessionString = process.env.TELEGRAM_SESSION || "";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const SYNC_ALL_CHATS =
  process.env.SYNC_ALL_CHATS === "1" || process.env.SYNC_ALL_CHATS === "true";
const CHAT_LIMIT = Number(process.env.SYNC_CHAT_LIMIT) || 0;
const UPSERT_BATCH = 500;

function log(level, event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

function getSupabase() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — cannot write presence to Supabase.",
    );
  }
  return createClient(SUPABASE_URL, key, { auth: { persistSession: false } });
}

// Читает справочник сотрудников (для сопоставления участников с ролями).
async function fetchEmployees(supabase) {
  const { data, error } = await supabase
    .from("employees")
    .select(
      "id, telegram_id, telegram_user_id, telegram_username, normalized_username, full_name, role, is_active",
    );
  if (error) throw new Error(`Не удалось прочитать employees: ${error.message}`);
  return data || [];
}

// Множество chat_id (строками), которые входят в проверяемую вселенную QA:
// активные и не исключённые чаты. По ним и пишем присутствие. SYNC_ALL_CHATS
// снимает это ограничение (тогда null — фильтра нет).
async function fetchKnownChatIds(supabase) {
  if (SYNC_ALL_CHATS) return null;
  const ids = new Set();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("chats")
      .select("chat_id")
      .eq("is_active", true)
      .eq("excluded_from_qa", false)
      .order("chat_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Не удалось прочитать chats: ${error.message}`);
    for (const r of data || []) ids.add(String(r.chat_id));
    if (!data || data.length < pageSize) break;
  }
  return ids;
}

async function upsertPresence(supabase, rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase
      .from("chat_employee_presence")
      .upsert(batch, { onConflict: "chat_id,employee_id" });
    if (error) throw new Error(`Ошибка upsert присутствия: ${error.message}`);
    written += batch.length;
  }
  return written;
}

async function main() {
  if (!apiId || !apiHash) {
    throw new Error("Заполните TELEGRAM_API_ID и TELEGRAM_API_HASH (my.telegram.org).");
  }
  if (!sessionString) {
    throw new Error(
      "TELEGRAM_SESSION не задан. Сначала войдите: `npm run telegram-login` и сохраните строку сессии.",
    );
  }

  const supabase = getSupabase();
  const [employees, knownChatIds] = await Promise.all([
    fetchEmployees(supabase),
    fetchKnownChatIds(supabase),
  ]);
  const index = buildEmployeeIndex(employees);
  log("info", "employees_loaded", {
    employees: employees.length,
    indexed_by_tg_id: index.byTgId.size,
    indexed_by_username: index.byUsername.size,
    chat_filter: knownChatIds ? knownChatIds.size : "all",
  });

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error("Сессия недействительна — выполните `npm run telegram-login` заново.");
  }
  const me = await client.getMe();
  log("info", "telegram_connected", {
    account: me?.username ? "@" + me.username : String(me?.id),
  });

  const checkedAt = new Date().toISOString();
  const allRows = [];
  let groupsSeen = 0;
  let groupsProcessed = 0;
  let groupsSkippedUnknown = 0;
  let matchesTotal = 0;
  const roleTotals = {};

  try {
    const dialogs = await client.getDialogs({});
    for (const dialog of dialogs) {
      // Нас интересуют только группы/супергруппы (там есть участники).
      // dialog.isGroup покрывает обычные группы и мегагруппы; каналы-вещания
      // и личные чаты пропускаем.
      if (!dialog.isGroup) continue;
      groupsSeen++;
      if (CHAT_LIMIT && groupsProcessed >= CHAT_LIMIT) break;

      const entity = dialog.entity;
      let markedId;
      try {
        markedId = getPeerId(entity);
      } catch {
        markedId = dialog.id;
      }
      const chatId = String(markedId);

      if (knownChatIds && !knownChatIds.has(chatId)) {
        groupsSkippedUnknown++;
        continue;
      }

      let participants;
      try {
        participants = await client.getParticipants(entity, {});
      } catch (err) {
        // Нет прав на список участников и т.п. — пропускаем чат, не падаем.
        log("warn", "participants_failed", { chat_id: chatId, error: err?.message });
        continue;
      }

      const simplified = participants.map((u) => ({
        id: u.id != null ? String(u.id) : null,
        username: u.username || null,
        statusClassName: u.participant?.className,
      }));

      const { rows, matched } = computePresenceForChat(chatId, simplified, index, {
        checkedAt,
      });
      groupsProcessed++;
      matchesTotal += matched.length;
      for (const m of matched) roleTotals[m.role] = (roleTotals[m.role] || 0) + 1;
      allRows.push(...rows);

      log("info", "chat_scanned", {
        chat_id: chatId,
        title: entity?.title || null,
        participants: participants.length,
        matched: matched.length,
      });
    }
  } finally {
    await client.disconnect();
    await client.destroy?.().catch(() => {});
  }

  const summary = {
    groups_seen: groupsSeen,
    groups_processed: groupsProcessed,
    groups_skipped_not_in_qa: groupsSkippedUnknown,
    matches_total: matchesTotal,
    presence_rows: allRows.length,
    role_totals: roleTotals,
  };

  if (DRY_RUN) {
    log("info", "dry_run_no_write", summary);
    return;
  }

  const written = allRows.length ? await upsertPresence(supabase, allRows) : 0;
  log("info", "sync_done", { ...summary, presence_written: written });
}

main().catch((err) => {
  log("error", "sync_failed", { error: err?.message || String(err) });
  process.exit(1);
});
