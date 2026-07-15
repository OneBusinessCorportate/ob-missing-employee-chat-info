// Тесты подписанной сессии-личности и вспомогательных функций личности.
// Env задаём ДО импорта (auth.js читает секрет при загрузке).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ACCESS_PASSWORD = "s3cret-pass";
const { signIdentity, readIdentity, identityFromReq } = await import("../lib/auth.js");
const { normalizeCode, isSupervisor, SUPERVISOR_ROLES } = await import("../lib/identity.js");

const IDENTITY = { employee_id: "emp-42", full_name: "Иван Петров", role: "accountant", can_see_all: false };

test("подписанная личность читается обратно без искажений", () => {
  const token = signIdentity(IDENTITY);
  const back = readIdentity(token);
  assert.deepEqual(back, IDENTITY);
});

test("подделанный токен личности отклоняется", () => {
  const token = signIdentity(IDENTITY);
  const tampered = token.slice(0, -2) + "00";
  assert.equal(readIdentity(tampered), null);
  assert.equal(readIdentity("v2.garbage.sig"), null);
  assert.equal(readIdentity("legacy.token"), null);
  assert.equal(readIdentity(""), null);
  assert.equal(readIdentity(null), null);
});

test("просроченный токен личности отклоняется", () => {
  const past = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const token = signIdentity(IDENTITY, past);
  assert.equal(readIdentity(token), null);
});

test("нельзя подменить личность подставив свой JSON без валидной подписи", () => {
  const forged =
    "v2." + Buffer.from(JSON.stringify({ sub: "boss", all: true, exp: Date.now() + 1e7 })).toString("base64url") + ".deadbeef";
  assert.equal(readIdentity(forged), null);
});

test("identityFromReq читает cookie ob_session", () => {
  const token = signIdentity(IDENTITY);
  const req = { headers: { cookie: `ob_session=${encodeURIComponent(token)}; other=1` } };
  assert.deepEqual(identityFromReq(req), IDENTITY);
  assert.equal(identityFromReq({ headers: {} }), null);
});

test("normalizeCode как в SQL-резолвере", () => {
  assert.equal(normalizeCode("a1b2-c3 d4"), "A1B2C3D4");
  assert.equal(normalizeCode(""), "");
  assert.equal(normalizeCode(null), "");
});

test("isSupervisor: привилегированные роли и can_see_all", () => {
  assert.equal(isSupervisor({ role: "head_accountant" }), true);
  assert.equal(isSupervisor({ role: "ceo" }), true);
  assert.equal(isSupervisor({ role: "accountant", can_see_all: true }), true);
  assert.equal(isSupervisor({ role: "accountant", can_see_all: false }), false);
  assert.equal(isSupervisor({ role: "ACCOUNTANT" }), false);
  assert.equal(isSupervisor(null), false);
  for (const r of ["head_accountant", "ceo", "founder", "qa", "admin"]) {
    assert.ok(SUPERVISOR_ROLES.has(r));
  }
});
