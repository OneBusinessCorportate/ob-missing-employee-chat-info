// Проверка личности бухгалтера по личному коду входа.
//
// Общий пароль (ACCESS_PASSWORD) закрывает дашборд от посторонних, но НЕ говорит,
// КТО именно вошёл, — а для персональной блокировки «сначала обработай вчерашние
// тикеты» сервер обязан достоверно знать бухгалтера. Личность берём из уже
// существующего в этом же проекте Supabase механизма: таблица login_codes + RPC
// resolve_login_code(p_code) (их же использует соседний дашборд бухгалтеров).
// Никаких новых таблиц/функций для входа не заводим.
//
// resolve_login_code возвращает { employee_id (uuid), full_name, role,
// can_see_all }. Резолвим ТОЛЬКО на сервере под service_role-ключом; браузер кода
// не резолвит и ключа не видит. Результат кладётся в подписанную (HMAC) cookie
// сессии — подделать личность из браузера нельзя (см. lib/auth.js).

import { getServiceClient } from "./supabaseServer.js";

// Канонизируем код так же, как это делает SQL-резолвер: убираем всё, кроме
// букв/цифр, и переводим в верхний регистр. Значит "a1b2-c3 d4" === "A1B2C3D4".
export function normalizeCode(code) {
  return (code || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// Роли, которые видят всё и в персональной блокировке НЕ участвуют (управление /
// надзор). Зеркалит SUPERVISOR_ROLES соседнего дашборда, чтобы у одного человека
// был одинаковый доступ в обоих приложениях.
export const SUPERVISOR_ROLES = new Set([
  "head_accountant",
  "ceo",
  "founder",
  "qa",
  "admin",
]);

export function isSupervisor(identity) {
  if (!identity) return false;
  if (identity.can_see_all) return true;
  const role = (identity.role ?? "").toString().trim().toLowerCase();
  return SUPERVISOR_ROLES.has(role);
}

// Резолвит код входа в личность { employee_id, full_name, role, can_see_all } или
// null, если код неизвестен. Только чтение; ничего не пишет.
export async function resolveLoginCode(code) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const client = getServiceClient();
  const { data, error } = await client.rpc("resolve_login_code", { p_code: norm });
  if (error) throw new Error(`resolve_login_code failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.employee_id) return null;
  return {
    employee_id: String(row.employee_id),
    full_name: row.full_name || "",
    role: row.role || "",
    can_see_all: Boolean(row.can_see_all),
  };
}
