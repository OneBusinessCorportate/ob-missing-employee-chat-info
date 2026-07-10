// Одноразовый вход в Telegram по номеру телефона (пользовательский аккаунт,
// MTProto — как в инструкции: my.telegram.org → api_id / api_hash → вход по
// номеру, коду из Telegram и, если есть, паролю 2FA).
//
// Запуск локально (интерактивно):
//   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram-login
//
// Скрипт спросит номер телефона, код из Telegram и пароль 2FA (если включён),
// после чего напечатает СТРОКУ СЕССИИ. Её нужно сохранить в переменную
// окружения TELEGRAM_SESSION (в Render — как секрет, sync:false). Дальше
// scripts/telegram-sync.js входит уже по этой строке, без повторного кода.
//
// Строка сессии = полный доступ к аккаунту. Не коммитьте её и не показывайте.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH || "";

async function main() {
  if (!apiId || !apiHash) {
    throw new Error(
      "Заполните TELEGRAM_API_ID и TELEGRAM_API_HASH (получить на my.telegram.org → API development tools).",
    );
  }

  const rl = readline.createInterface({ input, output });
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start({
      phoneNumber: async () =>
        (await rl.question("Номер телефона (в международном формате, напр. +374…): ")).trim(),
      phoneCode: async () =>
        (await rl.question("Код из Telegram: ")).trim(),
      password: async () =>
        (await rl.question("Пароль 2FA (если есть, иначе Enter): ")).trim(),
      onError: (err) => console.error("Ошибка входа:", err?.message || err),
    });

    const me = await client.getMe();
    const sessionString = client.session.save();

    console.log("\n✅ Вход выполнен как:", me?.username ? "@" + me.username : me?.firstName || me?.id?.toString());
    console.log("\n================ TELEGRAM_SESSION ================");
    console.log(sessionString);
    console.log("=================================================");
    console.log(
      "\nСохраните эту строку в переменную окружения TELEGRAM_SESSION\n" +
        "(локально — в .env, на Render — как секрет sync:false).\n" +
        "Никому не показывайте: это полный доступ к аккаунту.",
    );
  } finally {
    rl.close();
    await client.disconnect();
    // GramJS иногда держит открытые таймеры/сокеты — выходим явно.
    await client.destroy?.().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
