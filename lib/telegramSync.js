// Чистая логика синхронизации присутствия ответственных через ПОЛЬЗОВАТЕЛЬСКИЙ
// аккаунт Telegram (MTProto, вход по номеру телефона), а не через бота.
//
// Зачем: бот через Bot API умеет проверять членство только по одному человеку
// (getChatMember) и постоянно ошибается — «member not found», «chat not found»,
// «PARTICIPANT_ID_INVALID», «bot was kicked». Из-за этого в
// chat_employee_presence оседают ложные is_present=false, и дашборд показывает
// «нет ответственного», хотя человек в чате есть.
//
// Пользовательский аккаунт, который САМ состоит в этих чатах, может получить
// ПОЛНЫЙ список участников группы (GetParticipants). Мы сопоставляем участников
// со справочником employees (по Telegram id или @username) и записываем
// достоверные строки присутствия is_present=true.
//
// Здесь только чистые функции — без GramJS и без сети, чтобы их можно было
// тестировать (см. test/telegramSync.test.js). Работу с сетью и Supabase делает
// scripts/telegram-sync.js.

// Нормализуем @username: убираем ведущий @, пробелы, приводим к нижнему регистру.
export function normalizeUsername(u) {
  if (u == null) return null;
  const s = String(u).trim().replace(/^@+/, "").toLowerCase();
  return s || null;
}

// Строит индексы для быстрого сопоставления участника Telegram с сотрудником:
//   byTgId    — по числовому Telegram id (employees.telegram_id и telegram_user_id);
//   byUsername — по нормализованному @username (telegram_username / normalized_username).
// Индексируем только активных сотрудников по умолчанию — уволенные не должны
// «закрывать» роль в чате. Передайте includeInactive=true, чтобы учесть всех.
export function buildEmployeeIndex(employees, { includeInactive = false } = {}) {
  const byTgId = new Map();
  const byUsername = new Map();
  for (const e of employees || []) {
    if (!includeInactive && e.is_active === false) continue;
    for (const id of [e.telegram_id, e.telegram_user_id]) {
      if (id != null && id !== "") byTgId.set(String(id), e);
    }
    const un =
      normalizeUsername(e.telegram_username) ||
      normalizeUsername(e.normalized_username);
    // Не перезаписываем уже занятый username (первый сотрудник выигрывает —
    // детерминированно при одинаковом порядке строк).
    if (un && !byUsername.has(un)) byUsername.set(un, e);
  }
  return { byTgId, byUsername };
}

// Сопоставляет одного участника Telegram (объект с полями id и username) с
// сотрудником. Сначала по Telegram id (надёжнее — не меняется), затем по
// @username. Возвращает { employee, via } либо null, если совпадения нет.
export function matchEmployee(participant, index) {
  if (!participant || !index) return null;
  if (participant.id != null) {
    const hit = index.byTgId.get(String(participant.id));
    if (hit) return { employee: hit, via: "telegram_id" };
  }
  const un = normalizeUsername(participant.username);
  if (un) {
    const hit = index.byUsername.get(un);
    if (hit) return { employee: hit, via: "username" };
  }
  return null;
}

// Формирует строку для upsert в public.chat_employee_presence.
// Пишем ТОЛЬКО факт присутствия (is_present=true): пользовательский аккаунт
// видит участника в списке — значит он точно в чате. Отсутствие в списке мы
// НЕ записываем (не выставляем is_present=false), чтобы не воспроизвести ту же
// ложную «пропажу», от которой уходим. Так синхронизация может лишь снять
// ложное «нет ответственного», но не создать новое.
export function buildPresenceRow(chatId, employee, { status = "member", checkedAt } = {}) {
  return {
    chat_id: Number(chatId),
    employee_id: employee.id,
    telegram_id:
      employee.telegram_id != null
        ? Number(employee.telegram_id)
        : employee.telegram_user_id != null
          ? Number(employee.telegram_user_id)
          : null,
    employee_name: employee.full_name ?? null,
    employee_role: employee.role ?? null,
    is_present: true,
    telegram_status: status,
    checked_at: checkedAt,
    detected_at: checkedAt,
  };
}

// Переводит класс участника GramJS в человекочитаемый статус, совместимый с
// уже имеющимися значениями telegram_status ('creator' / 'administrator' /
// 'member'). Неизвестное/отсутствующее — 'member'.
export function participantStatus(className) {
  if (!className) return "member";
  if (className.includes("Creator")) return "creator";
  if (className.includes("Admin")) return "administrator";
  return "member";
}

// Сводит участников одного чата в строки присутствия. Дедуп по employee_id:
// один сотрудник может совпасть и по id, и по username — берём одну строку.
// participants: массив { id, username, statusClassName? }.
// Возвращает { rows, matched } — rows готовы к upsert, matched для логов.
export function computePresenceForChat(chatId, participants, index, { checkedAt } = {}) {
  const byEmployee = new Map();
  for (const p of participants || []) {
    const m = matchEmployee(p, index);
    if (!m) continue;
    const empId = m.employee.id;
    if (byEmployee.has(empId)) continue;
    byEmployee.set(empId, {
      row: buildPresenceRow(chatId, m.employee, {
        status: participantStatus(p.statusClassName),
        checkedAt,
      }),
      via: m.via,
      role: m.employee.role,
      name: m.employee.full_name,
    });
  }
  const matched = [...byEmployee.values()];
  return { rows: matched.map((m) => m.row), matched };
}
