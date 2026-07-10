// Пошаговый вход в Telegram по номеру телефона ЧЕРЕЗ БРАУЗЕР (для Render).
//
// Зачем: вход по номеру интерактивный — надо ввести код из Telegram и, если
// есть, пароль 2FA. В кроне это сделать нельзя (некому вводить код), а Shell на
// Render легко «отваливается на полпути». Поэтому вход разбит на HTTP-шаги, а
// само MTProto-подключение живёт В ПАМЯТИ всегда работающего веб-сервиса между
// запросами — оно не пропадает, пока идёт ввод.
//
// Состояние — один активный вход на процесс (вход одноразовый). Клиент GramJS
// создаётся при шаге «отправить код», хранится до ввода кода/пароля, затем
// отдаёт строку сессии и закрывается.
//
// Всё это включается только флагом TELEGRAM_LOGIN_ENABLED=1 и живёт под общей
// авторизацией дашборда (см. server.js).

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { computeCheck } from "telegram/Password.js";

const LOGIN_TTL_MS = 10 * 60 * 1000; // код Telegram живёт недолго — 10 минут на всё

// Единственное активное состояние входа в этом процессе.
let state = null; // { client, phoneCodeHash, phone, step, createdAt }

function apiCreds() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH || "";
  if (!apiId || !apiHash) {
    const e = new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH не заданы на сервере.");
    e.code = "no_credentials";
    throw e;
  }
  return { apiId, apiHash };
}

async function resetState() {
  const s = state;
  state = null;
  if (s?.client) {
    try {
      await s.client.disconnect();
      await s.client.destroy?.();
    } catch {
      // игнорируем — просто чистим
    }
  }
}

function expired() {
  return state && Date.now() - state.createdAt > LOGIN_TTL_MS;
}

// Дружелюбный текст для типовых ошибок Telegram.
function friendly(err) {
  const msg = String(err?.errorMessage || err?.message || err);
  if (msg.includes("PHONE_NUMBER_INVALID")) return "Неверный номер телефона.";
  if (msg.includes("PHONE_CODE_INVALID")) return "Неверный код. Попробуйте ещё раз.";
  if (msg.includes("PHONE_CODE_EXPIRED")) return "Код истёк — начните вход заново.";
  if (msg.includes("PASSWORD_HASH_INVALID")) return "Неверный пароль 2FA.";
  if (msg.includes("FLOOD_WAIT")) return "Слишком много попыток. Подождите и попробуйте позже.";
  return msg;
}

// Шаг 1: отправить код на номер. Начинает новый вход (сбрасывает предыдущий).
export async function beginLogin(phone) {
  const cleanPhone = String(phone || "").trim();
  if (!cleanPhone) {
    const e = new Error("Укажите номер телефона.");
    e.code = "bad_request";
    throw e;
  }
  await resetState();
  const { apiId, apiHash } = apiCreds();
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  try {
    const res = await client.sendCode({ apiId, apiHash }, cleanPhone);
    state = {
      client,
      phone: cleanPhone,
      phoneCodeHash: res.phoneCodeHash,
      step: "code",
      createdAt: Date.now(),
    };
    return { step: "code" };
  } catch (err) {
    await client.disconnect().catch(() => {});
    await client.destroy?.().catch(() => {});
    const e = new Error(friendly(err));
    e.code = "telegram_error";
    throw e;
  }
}

// Шаг 2: подтвердить код из Telegram. Возвращает { step: 'password' } если
// включена 2FA, иначе { step: 'done', session }.
export async function confirmCode(code) {
  if (!state || state.step !== "code") {
    const e = new Error("Сначала запросите код (введите номер телефона).");
    e.code = "no_login";
    throw e;
  }
  if (expired()) {
    await resetState();
    const e = new Error("Время входа истекло — начните заново.");
    e.code = "expired";
    throw e;
  }
  const cleanCode = String(code || "").trim();
  try {
    await state.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: state.phone,
        phoneCodeHash: state.phoneCodeHash,
        phoneCode: cleanCode,
      }),
    );
    return await finalize();
  } catch (err) {
    const msg = String(err?.errorMessage || err?.message || err);
    if (msg.includes("SESSION_PASSWORD_NEEDED")) {
      state.step = "password";
      return { step: "password" };
    }
    const e = new Error(friendly(err));
    e.code = "telegram_error";
    throw e;
  }
}

// Шаг 3 (если есть 2FA): подтвердить пароль облачной защиты.
export async function confirmPassword(password) {
  if (!state || state.step !== "password") {
    const e = new Error("Пароль сейчас не запрашивается.");
    e.code = "no_login";
    throw e;
  }
  if (expired()) {
    await resetState();
    const e = new Error("Время входа истекло — начните заново.");
    e.code = "expired";
    throw e;
  }
  try {
    const pwdInfo = await state.client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(pwdInfo, String(password || ""));
    await state.client.invoke(new Api.auth.CheckPassword({ password: check }));
    return await finalize();
  } catch (err) {
    const e = new Error(friendly(err));
    e.code = "telegram_error";
    throw e;
  }
}

// Успешный вход: сохраняем строку сессии, закрываем клиент, чистим состояние.
async function finalize() {
  const client = state.client;
  let me = null;
  try {
    me = await client.getMe();
  } catch {
    // не критично для выдачи сессии
  }
  const session = client.session.save();
  const account = me?.username ? "@" + me.username : me?.firstName || String(me?.id || "");
  await resetState();
  return { step: "done", session, account };
}

// Текущий шаг (для отрисовки страницы): 'phone' | 'code' | 'password'.
export function currentStep() {
  if (expired()) return "phone";
  return state?.step === "password" ? "password" : state?.step === "code" ? "code" : "phone";
}

// Отмена/сброс входа вручную.
export async function cancelLogin() {
  await resetState();
  return { step: "phone" };
}

export const loginEnabled = () =>
  process.env.TELEGRAM_LOGIN_ENABLED === "1" ||
  process.env.TELEGRAM_LOGIN_ENABLED === "true";
