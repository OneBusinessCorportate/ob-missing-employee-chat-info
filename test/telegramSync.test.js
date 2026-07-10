// Юнит-тесты чистой логики синхронизации присутствия через пользовательский
// аккаунт Telegram (node:test, без GramJS и без сети).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUsername,
  buildEmployeeIndex,
  matchEmployee,
  buildPresenceRow,
  participantStatus,
  computePresenceForChat,
} from "../lib/telegramSync.js";

const EMPLOYEES = [
  {
    id: "e-acc",
    full_name: "Inga Hovsepyan",
    role: "accountant",
    telegram_id: 5453741106,
    telegram_username: "@Inga_H",
    is_active: true,
  },
  {
    id: "e-mgr",
    full_name: "Manager OneBusiness",
    role: "manager",
    telegram_user_id: 6791113556, // только telegram_user_id
    is_active: true,
  },
  {
    id: "e-head",
    full_name: "Head Acc",
    role: "head_accountant",
    normalized_username: "headacc", // только по username
    is_active: true,
  },
  {
    id: "e-old",
    full_name: "Уволенный",
    role: "accountant",
    telegram_id: 111,
    is_active: false,
  },
];

test("normalizeUsername убирает @, пробелы и регистр", () => {
  assert.equal(normalizeUsername("@Inga_H"), "inga_h");
  assert.equal(normalizeUsername("  HeadAcc "), "headacc");
  assert.equal(normalizeUsername(""), null);
  assert.equal(normalizeUsername(null), null);
});

test("buildEmployeeIndex индексирует по telegram_id, telegram_user_id и username", () => {
  const idx = buildEmployeeIndex(EMPLOYEES);
  assert.equal(idx.byTgId.get("5453741106").id, "e-acc");
  assert.equal(idx.byTgId.get("6791113556").id, "e-mgr");
  assert.equal(idx.byUsername.get("inga_h").id, "e-acc");
  assert.equal(idx.byUsername.get("headacc").id, "e-head");
});

test("buildEmployeeIndex по умолчанию пропускает уволенных", () => {
  const idx = buildEmployeeIndex(EMPLOYEES);
  assert.equal(idx.byTgId.has("111"), false);
  const idxAll = buildEmployeeIndex(EMPLOYEES, { includeInactive: true });
  assert.equal(idxAll.byTgId.get("111").id, "e-old");
});

test("matchEmployee: сначала по Telegram id, затем по username", () => {
  const idx = buildEmployeeIndex(EMPLOYEES);
  const byId = matchEmployee({ id: 5453741106, username: "somethingelse" }, idx);
  assert.equal(byId.employee.id, "e-acc");
  assert.equal(byId.via, "telegram_id");

  const byName = matchEmployee({ id: 999999, username: "@HeadAcc" }, idx);
  assert.equal(byName.employee.id, "e-head");
  assert.equal(byName.via, "username");

  assert.equal(matchEmployee({ id: 42, username: "nobody" }, idx), null);
  assert.equal(matchEmployee(null, idx), null);
});

test("participantStatus маппит класс GramJS в статус", () => {
  assert.equal(participantStatus("ChannelParticipantCreator"), "creator");
  assert.equal(participantStatus("ChatParticipantCreator"), "creator");
  assert.equal(participantStatus("ChannelParticipantAdmin"), "administrator");
  assert.equal(participantStatus("ChannelParticipant"), "member");
  assert.equal(participantStatus(undefined), "member");
});

test("buildPresenceRow формирует корректную строку (is_present=true)", () => {
  const row = buildPresenceRow(-1002954615886, EMPLOYEES[0], {
    status: "member",
    checkedAt: "2026-07-10T00:00:00Z",
  });
  assert.equal(row.chat_id, -1002954615886);
  assert.equal(row.employee_id, "e-acc");
  assert.equal(row.telegram_id, 5453741106);
  assert.equal(row.employee_role, "accountant");
  assert.equal(row.is_present, true);
  assert.equal(row.telegram_status, "member");
  assert.equal(row.checked_at, "2026-07-10T00:00:00Z");
  assert.equal(row.detected_at, "2026-07-10T00:00:00Z");
});

test("buildPresenceRow берёт telegram_user_id, если нет telegram_id", () => {
  const row = buildPresenceRow(-5, EMPLOYEES[1], {});
  assert.equal(row.telegram_id, 6791113556);
});

test("computePresenceForChat сопоставляет участников и даёт строки присутствия", () => {
  const idx = buildEmployeeIndex(EMPLOYEES);
  const participants = [
    { id: "5453741106", username: null, statusClassName: "ChannelParticipantAdmin" }, // acc по id
    { id: "6791113556", username: "manager_ob" }, // mgr по id
    { id: "42", username: "@HeadAcc" }, // head по username
    { id: "777", username: "outsider" }, // не сотрудник
  ];
  const { rows, matched } = computePresenceForChat(-100123, participants, idx, {
    checkedAt: "2026-07-10T00:00:00Z",
  });
  assert.equal(rows.length, 3);
  assert.equal(matched.length, 3);
  const roles = rows.map((r) => r.employee_role).sort();
  assert.deepEqual(roles, ["accountant", "head_accountant", "manager"]);
  const acc = rows.find((r) => r.employee_role === "accountant");
  assert.equal(acc.telegram_status, "administrator");
  assert.ok(rows.every((r) => r.chat_id === -100123 && r.is_present === true));
});

test("computePresenceForChat дедупит одного сотрудника (совпал и по id, и по username)", () => {
  const idx = buildEmployeeIndex(EMPLOYEES);
  const participants = [
    { id: "5453741106", username: "inga_h" }, // тот же сотрудник дважды предствлен
  ];
  const { rows } = computePresenceForChat(-1, participants, idx, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].employee_id, "e-acc");
});

test("computePresenceForChat: нет совпадений — пустой результат", () => {
  const idx = buildEmployeeIndex(EMPLOYEES);
  const { rows, matched } = computePresenceForChat(-1, [{ id: "1", username: "x" }], idx, {});
  assert.equal(rows.length, 0);
  assert.equal(matched.length, 0);
});
