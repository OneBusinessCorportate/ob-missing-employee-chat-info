// Shared logic: read client_telegram_chats from Supabase and work out which
// chats are missing a responsible person. Used by both the web API (server.js)
// and the daily Telegram summary (scripts/daily-report.js) so the counts on the
// dashboard and in Telegram can never disagree.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://fjsogozwseqoxgddjeig.supabase.co";

// The service role key is required because client_telegram_chats has RLS
// enabled and only allows authenticated, non-restricted users. We keep the key
// server-side only. The client is created lazily so that the pure helpers in
// this module (computeProblems) can be imported/tested without any env vars.
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

// The three roles this checklist cares about.
export const TRACKED_ROLES = [
  { key: "accountant", label: "Бухгалтер", flag: "missing_accountant" },
  { key: "head_accountant", label: "Главный бухгалтер", flag: "missing_head_accountant" },
  { key: "manager", label: "Менеджер", flag: "missing_manager" },
];

// A role can be stored either inside the `participants` jsonb object
// (production schema, e.g. participants.accountant = [...]) or, in some
// projects, as a dedicated top-level jsonb column (accountants,
// head_accountants, managers). We handle both so the logic is portable.
function roleList(row, roleKey) {
  const participants = row.participants || {};
  const fromParticipants = participants[roleKey];
  if (Array.isArray(fromParticipants)) return fromParticipants;

  // Fallback to a pluralised top-level column if present.
  const pluralCol = roleKey === "head_accountant" ? "head_accountants" : `${roleKey}s`;
  const fromColumn = row[pluralCol];
  if (Array.isArray(fromColumn)) return fromColumn;

  return [];
}

function isMissing(row, roleKey) {
  return roleList(row, roleKey).length === 0;
}

// Pure reducer: given raw chat rows, produce the problematic list + counts.
// Kept side-effect free so it can be unit-tested without Supabase.
export function computeProblems(data) {
  const rows = data || [];

  // Названия чатов не уникальны (в данных есть несколько «testchat1» и т.п.).
  // Считаем, сколько раз встречается каждое название, чтобы потом пометить
  // такие строки как «неоднозначные» и показать уточняющие поля.
  const nameCounts = new Map();
  for (const row of rows) {
    const name = row.chat_name || "(без названия)";
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }

  const chats = rows.map((row) => {
    const missing_accountant = isMissing(row, "accountant");
    const missing_head_accountant = isMissing(row, "head_accountant");
    const missing_manager = isMissing(row, "manager");
    const chat_name = row.chat_name || "(без названия)";
    // Число отсутствующих ролей — используется для сортировки «сначала худшие».
    const missing_count =
      (missing_accountant ? 1 : 0) +
      (missing_head_accountant ? 1 : 0) +
      (missing_manager ? 1 : 0);
    return {
      id: row.id,
      chat_name,
      client_name: row.client_name || null,
      contract_number: row.contract_number || null,
      chat_link: row.chat_link || null,
      telegram_chat_id: row.telegram_chat_id || null,
      status: row.status || null,
      language: row.language || null,
      updated_at: row.updated_at || null,
      missing_accountant,
      missing_head_accountant,
      missing_manager,
      missing_count,
      // true, если такое же название есть у другого чата — строку нужно
      // различать по договору / клиенту / telegram_chat_id.
      ambiguous: nameCounts.get(chat_name) > 1,
    };
  });

  const problems = chats.filter(
    (c) => c.missing_accountant || c.missing_head_accountant || c.missing_manager,
  );

  // Самое свежее время изменения среди ВСЕХ чатов — показываем как
  // «данные актуальны на …», чтобы было видно, насколько свежий срез.
  let dataUpdatedAt = null;
  for (const row of rows) {
    if (row.updated_at && (!dataUpdatedAt || row.updated_at > dataUpdatedAt)) {
      dataUpdatedAt = row.updated_at;
    }
  }

  const counts = {
    total_problems: problems.length,
    missing_accountant: problems.filter((c) => c.missing_accountant).length,
    missing_head_accountant: problems.filter((c) => c.missing_head_accountant).length,
    missing_manager: problems.filter((c) => c.missing_manager).length,
    total_chats: chats.length,
    data_updated_at: dataUpdatedAt,
  };

  return { problems, counts };
}

// Fetch all chats from Supabase and reduce them.
// A chat is problematic when it is missing at least one tracked role.
export async function getProblemChats() {
  const { data, error } = await getClient()
    .from("client_telegram_chats")
    .select(
      "id, chat_name, client_name, contract_number, chat_link, telegram_chat_id, status, language, participants, updated_at",
    )
    .order("chat_name", { ascending: true });

  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return computeProblems(data);
}
