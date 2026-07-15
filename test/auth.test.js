// Тесты входа: подпись/проверка токена, пароль, разбор cookie.
// Env задаём ДО импорта модуля (auth.js читает ACCESS_PASSWORD при загрузке).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ACCESS_PASSWORD = "s3cret-pass";
const {
  issueToken,
  verifyToken,
  checkPassword,
  parseCookies,
  authEnabled,
  signSession,
  readSession,
} = await import("../lib/auth.js");

test("вход включён, когда задан ACCESS_PASSWORD", () => {
  assert.equal(authEnabled, true);
});

test("правильный пароль проходит, неправильный — нет", () => {
  assert.equal(checkPassword("s3cret-pass"), true);
  assert.equal(checkPassword("wrong"), false);
  assert.equal(checkPassword(""), false);
});

test("валидный токен проходит проверку", () => {
  const token = issueToken();
  assert.equal(verifyToken(token), true);
});

test("просроченный токен отклоняется", () => {
  const past = Date.now() - 60 * 24 * 60 * 60 * 1000; // задолго до сейчас
  const token = issueToken(past);
  assert.equal(verifyToken(token), false);
});

test("подделанный токен отклоняется", () => {
  const token = issueToken();
  const tampered = token.slice(0, -2) + "00";
  assert.equal(verifyToken(tampered), false);
  assert.equal(verifyToken("мусор"), false);
  assert.equal(verifyToken(""), false);
  assert.equal(verifyToken(null), false);
});

test("сессия бухгалтера подписывается и читается сервером", () => {
  const token = signSession({ emp: "emp-42", adm: false, name: "Тест" });
  const s = readSession(token);
  assert.equal(s.emp, "emp-42");
  assert.equal(s.adm, false);
  assert.equal(s.name, "Тест");
});

test("подделанная/просроченная сессия отклоняется (identity не из браузера)", () => {
  const token = signSession({ emp: "emp-42", adm: true });
  // Подмена полезной нагрузки без валидной подписи не проходит.
  const tampered = token.slice(0, -2) + (token.endsWith("00") ? "11" : "00");
  assert.equal(readSession(tampered), null);
  assert.equal(readSession("garbage"), null);
  assert.equal(readSession(""), null);
  const expired = signSession({ emp: "e" }, Date.now() - 60 * 24 * 60 * 60 * 1000);
  assert.equal(readSession(expired), null);
});

test("разбор cookie-заголовка", () => {
  const c = parseCookies("ob_session=abc%20def; other=1");
  assert.equal(c.ob_session, "abc def");
  assert.equal(c.other, "1");
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(undefined), {});
});
