// Здоровье синхронизации присутствия.
//
// Детект «кто в чате» держится на ежедневной синхронизации участников через
// пользовательский аккаунт Telegram (scripts/telegram-sync.js). Её слабое место —
// сессия (TELEGRAM_SESSION) может истечь: тогда крон молча падает, presence
// перестаёт обновляться, а дашборд/сводка выглядят рабочими, но опираются на
// устаревшие данные (реальный случай: данные «зависли» на 6 дней).
//
// Здесь мы измеряем свежесть синхронизации: когда в последний раз реальная
// проверка членства записала строки присутствия. Если давно — значит логика
// «сломалась» и её надо чинить (обычно — заново войти в Telegram). Сводка и
// дашборд показывают предупреждение, чтобы это заметили НА СЛЕДУЮЩЕЕ УТРО, а не
// через неделю.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://fjsogozwseqoxgddjeig.supabase.co";

// Статусы telegram_status, которые пишет ИМЕННО синхронизация членства
// (participantStatus в lib/telegramSync.js). Их свежесть = свежесть синка.
// 'inferred_from_message' (сообщения), 'manual' (ручная правка) и старые
// ошибки бота сюда НЕ входят — иначе активность в чатах маскировала бы мёртвый
// синк.
export const SYNC_STATUSES = ["member", "administrator", "creator"];

// Порог устаревания. Синк идёт ежедневно (~03:30), сводка — в ~04:00, поэтому у
// здорового синка возраст ~полчаса. 30 часов = «сегодня не прошёл и вчера тоже
// под вопросом» без ложных срабатываний на суточную периодичность.
const DEFAULT_MAX_AGE_HOURS = 30;

export function maxAgeHoursFromEnv() {
  const raw = Number(process.env.SYNC_MAX_AGE_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_HOURS;
}

// Чистая функция: по времени последней синхронизации считает возраст и признак
// устаревания. Тестируется без Supabase.
//   lastSyncAt — ISO-строка/Date/null (null = синхронизаций ещё не было).
export function computeSyncHealth(
  lastSyncAt,
  { now = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {},
) {
  const last = lastSyncAt ? new Date(lastSyncAt) : null;
  const valid = last && !Number.isNaN(last.getTime());
  const ageHours = valid ? (now.getTime() - last.getTime()) / 3_600_000 : null;
  // Никогда не синхронизировались (null) — тоже считаем «несвежим»: детект
  // членства не работал ни разу.
  const stale = !valid || ageHours > maxAgeHours;
  return {
    last_sync_at: valid ? last.toISOString() : null,
    age_hours: ageHours,
    stale,
    max_age_hours: maxAgeHours,
  };
}

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

// Читает время последней синхронизации членства из chat_employee_presence
// (максимальный checked_at среди строк с sync-статусами) и возвращает
// computeSyncHealth. Только чтение.
export async function getSyncHealth({ now = new Date(), maxAgeHours = maxAgeHoursFromEnv() } = {}) {
  const client = getClient();
  const { data, error } = await client
    .from("chat_employee_presence")
    .select("checked_at")
    .in("telegram_status", SYNC_STATUSES)
    .not("checked_at", "is", null)
    .order("checked_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  const lastSyncAt = data && data.length ? data[0].checked_at : null;
  return computeSyncHealth(lastSyncAt, { now, maxAgeHours });
}
