// Тесты свежести синхронизации присутствия (node:test, без Supabase).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSyncHealth, SYNC_STATUSES } from "../lib/syncHealth.js";

const now = new Date("2026-07-16T04:00:00Z");

test("свежая синхронизация (полчаса назад) — не устарела", () => {
  const h = computeSyncHealth("2026-07-16T03:30:00Z", { now, maxAgeHours: 30 });
  assert.equal(h.stale, false);
  assert.ok(h.age_hours < 1);
  assert.equal(h.last_sync_at, "2026-07-16T03:30:00.000Z");
});

test("одна пропущенная синхронизация (~24ч) — ещё не устарела при пороге 30ч", () => {
  const h = computeSyncHealth("2026-07-15T03:30:00Z", { now, maxAgeHours: 30 });
  assert.equal(h.stale, false);
});

test("две пропущенные синхронизации (~48ч) — устарела", () => {
  const h = computeSyncHealth("2026-07-14T03:30:00Z", { now, maxAgeHours: 30 });
  assert.equal(h.stale, true);
  assert.ok(h.age_hours > 48);
});

test("многодневный простой (реальный кейс 6 дней) — устарела", () => {
  const h = computeSyncHealth("2026-07-10T10:07:00Z", { now, maxAgeHours: 30 });
  assert.equal(h.stale, true);
});

test("синхронизаций не было (null) — считается устаревшей", () => {
  const h = computeSyncHealth(null, { now, maxAgeHours: 30 });
  assert.equal(h.stale, true);
  assert.equal(h.last_sync_at, null);
  assert.equal(h.age_hours, null);
});

test("некорректная дата — считается устаревшей, не падает", () => {
  const h = computeSyncHealth("не дата", { now, maxAgeHours: 30 });
  assert.equal(h.stale, true);
  assert.equal(h.last_sync_at, null);
});

test("порог возвращается в результате", () => {
  const h = computeSyncHealth("2026-07-16T03:30:00Z", { now, maxAgeHours: 42 });
  assert.equal(h.max_age_hours, 42);
});

test("sync-статусы — только реальная проверка членства", () => {
  assert.deepEqual(SYNC_STATUSES, ["member", "administrator", "creator"]);
  assert.ok(!SYNC_STATUSES.includes("inferred_from_message"));
  assert.ok(!SYNC_STATUSES.includes("manual"));
});
