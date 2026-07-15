// Единый серверный клиент Supabase (service_role). Ключ живёт ТОЛЬКО на сервере
// и никогда не попадает в браузер, логи или ответы API. Клиент создаётся лениво,
// чтобы чистые функции можно было импортировать/тестировать без переменных
// окружения.
//
// Тот же приём уже используют lib/problemChats.js и lib/clientChecks.js — здесь
// он вынесен в один модуль, чтобы новый код (личность бухгалтера + разбор
// тикетов) не плодил ещё одну копию.

import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://fjsogozwseqoxgddjeig.supabase.co";

let _client = null;

export function getServiceClient() {
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

// Только для тестов: позволяет подставить фейковый клиент и не ходить в сеть.
export function __setServiceClientForTests(client) {
  _client = client;
}
