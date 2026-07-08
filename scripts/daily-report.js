// Daily Telegram summary.
//
// Sends ONLY a short summary + a link to the dashboard — never the full list.
// Intended to run once a day as a Render Cron Job.
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN  - bot that posts the summary
//   TELEGRAM_CHAT_ID    - chat/group the summary is posted to
//   PLATFORM_URL        - public URL of the dashboard (the link in the message)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - to read the chats
//
// Optional:
//   DRY_RUN=1           - print the message instead of sending it

import { getProblemChats } from "../lib/problemChats.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PLATFORM_URL = process.env.PLATFORM_URL || "";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

function buildMessage(counts) {
  if (counts.total_problems === 0) {
    let msg = "✅ Все чаты в порядке — проблемных чатов нет.";
    if (PLATFORM_URL) {
      msg += `\n\nЧтобы увидеть больше информации, перейдите по ссылке:\n${PLATFORM_URL}`;
    }
    return msg;
  }

  const lines = [
    `У нас есть ${counts.total_problems} проблемных чатов, из которых:`,
    "",
    `• ${counts.missing_accountant} без бухгалтера`,
    `• ${counts.missing_head_accountant} без главного бухгалтера`,
    `• ${counts.missing_manager} без менеджера`,
    "",
    "Чтобы увидеть больше информации, перейдите по ссылке:",
    PLATFORM_URL || "(ссылка на платформу не настроена — задайте PLATFORM_URL)",
  ];
  return lines.join("\n");
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const { counts } = await getProblemChats();
  const message = buildMessage(counts);

  console.log("---- Daily summary ----");
  console.log(message);
  console.log("-----------------------");

  if (DRY_RUN) {
    console.log("DRY_RUN set — not sending to Telegram.");
    return;
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set to send the summary (or set DRY_RUN=1 to test).",
    );
  }

  await sendTelegram(message);
  console.log("Summary sent to Telegram.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
