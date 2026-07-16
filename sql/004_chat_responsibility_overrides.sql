-- Аддитивная миграция: ручные корректировки чек-листа ответственных.
-- Применяется к проекту OB FAQ (fjsogozwseqoxgddjeig).
--
-- ЗАЧЕМ. Раньше единственными рычагами были presence-строки (кто в чате) и
-- excluded_from_qa (убрать чат целиком). Этого не хватало для двух частых
-- реальных ситуаций, которые операторы правили «руками», но платформа их не
-- видела и снова помечала чат проблемным:
--
--   1) «Бухгалтер не должен быть в этом чате» — роль для конкретного чата НЕ
--      требуется (напр. клиент на другом тарифе). Раньше такой чат вечно висел
--      как «нет бухгалтера», хотя это не проблема.
--   2) «Ответственный есть, но проверка его не видит» — человек в чате, но бот
--      не смог подтвердить членство, ЛИБО сотрудник помечен is_active=false в
--      справочнике employees (тогда синхронизация его пропускает). Роль по факту
--      закрыта, но флаг стоит «нет ответственного».
--
-- РЕШЕНИЕ. Небольшая таблица ручных оверрайдов «(чат, роль) -> статус»:
--   status='not_required' — роль для этого чата не требуется (не считать пропуском);
--   status='present'      — роль подтверждена вручную (считать закрытой).
-- Вью v_chat_missing_responsibles учитывает их: 'present' закрывает роль так же,
-- как реальное присутствие/сообщение; 'not_required' убирает роль из требуемых.
--
-- БЕЗОПАСНО ПО ДИЗАЙНУ: оверрайд может только СНЯТЬ ложную проблему
-- (not_required/present), но не может создать новую — как и телеграм-синк. Ничего
-- в существующих таблицах не меняется; правки обратимы (удалить строку).

create table if not exists public.chat_responsibility_overrides (
  chat_id    bigint not null,
  role       text   not null check (role in ('accountant', 'head_accountant', 'manager')),
  status     text   not null check (status in ('not_required', 'present')),
  note       text,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (chat_id, role)
);

comment on table public.chat_responsibility_overrides is
  'Ручные корректировки чек-листа ответственных: (chat_id, role) -> not_required | present. Только снимает ложные пропуски; исходные таблицы не меняет.';

-- RLS включаем без политик: таблица содержит операционные пометки. Вью читает её
-- от владельца (security_invoker=false, см. ниже), а запись идёт под service_role
-- (обходит RLS). Публичным ролям прямой доступ не нужен.
alter table public.chat_responsibility_overrides enable row level security;
revoke all on public.chat_responsibility_overrides from anon, authenticated;

-- Пересобираем вью с учётом оверрайдов. Логика присутствия/сообщений — прежняя;
-- добавлены только req_* (требуется ли роль) и учёт status='present' в has_*.
drop view if exists public.v_chat_missing_responsibles;

create view public.v_chat_missing_responsibles as
with pres as (
  select chat_id,
    bool_or(employee_role = 'accountant'      and is_present) as p_acc,
    bool_or(employee_role = 'head_accountant' and is_present) as p_head,
    bool_or(employee_role = 'manager'         and is_present) as p_mgr,
    count(*) as pres_rows,
    max(checked_at) as pres_checked_at
  from public.chat_employee_presence
  group by chat_id
),
msg as (
  select chat_id,
    bool_or(sender_role = 'accountant')      as m_acc,
    bool_or(sender_role = 'head_accountant') as m_head,
    bool_or(sender_role = 'manager')         as m_mgr,
    count(*) as msg_rows,
    max(created_at) as last_msg_at
  from public.messages
  group by chat_id
),
ovr as (
  select chat_id,
    max(status) filter (where role = 'accountant')      as o_acc,
    max(status) filter (where role = 'head_accountant') as o_head,
    max(status) filter (where role = 'manager')         as o_mgr,
    max(updated_at) as ovr_updated_at
  from public.chat_responsibility_overrides
  group by chat_id
)
select
  c.chat_id,
  c.chat_name,
  -- Роль закрыта, если человек присутствует, ИЛИ писал в чат, ИЛИ отмечена
  -- вручную как present. coalesce(... = 'present', false) обязателен: при
  -- отсутствии оверрайда o_* = NULL, а `false OR NULL` в SQL даёт NULL и «съел»
  -- бы реальный сигнал — оборачиваем сравнение, чтобы оно давало строго boolean.
  coalesce(pr.p_acc,  false) or coalesce(mg.m_acc,  false) or coalesce(o.o_acc  = 'present', false) as has_accountant,
  coalesce(pr.p_head, false) or coalesce(mg.m_head, false) or coalesce(o.o_head = 'present', false) as has_head_accountant,
  coalesce(pr.p_mgr,  false) or coalesce(mg.m_mgr,  false) or coalesce(o.o_mgr  = 'present', false) as has_manager,
  -- Роль требуется, если для неё нет оверрайда not_required.
  coalesce(o.o_acc,  '') <> 'not_required' as req_accountant,
  coalesce(o.o_head, '') <> 'not_required' as req_head_accountant,
  coalesce(o.o_mgr,  '') <> 'not_required' as req_manager,
  (coalesce(pr.pres_rows, 0) > 0 or coalesce(mg.msg_rows, 0) > 0) as checked,
  greatest(pr.pres_checked_at, mg.last_msg_at) as checked_at
from public.chats c
left join pres pr on pr.chat_id = c.chat_id
left join msg  mg on mg.chat_id = c.chat_id
left join ovr  o  on o.chat_id  = c.chat_id
where c.is_active and not c.excluded_from_qa;

-- RLS-safe чтение (как в миграции 002): вью исполняется от владельца postgres и
-- доступна ключам проекта, чтобы дашборд и крон-сводка читали одни и те же цифры.
alter view public.v_chat_missing_responsibles set (security_invoker = false);
grant select on public.v_chat_missing_responsibles to anon, authenticated;
