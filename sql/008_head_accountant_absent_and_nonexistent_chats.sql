-- Аддитивная миграция. Применяется к проекту OB FAQ (fjsogozwseqoxgddjeig).
--
-- Две независимые правки ручной коррекции данных:
--
-- (A) Пер-чатовое «нет главного бухгалтера». Раньше главный бухгалтер считался
--     общекомпанийным (миграция 004): если в компании есть активный
--     head_accountant, то has_head_accountant=true у ВСЕХ чатов, и ни один чат
--     не мог показать «Нет главного бухгалтера». Теперь ручной оверрайд с
--     role='head_accountant' и status='absent' ПРИНУДИТЕЛЬНО ставит
--     has_head_accountant=false для конкретного чата (главбуха нет именно в этом
--     чате), перекрывая общекомпанийное значение. На остальные чаты правило
--     «общекомпанийного главбуха» по-прежнему распространяется.
--
-- (B) «Чат не существует». Список чатов, которых физически больше нет в Telegram
--     (ручная отметка QA). Такие чаты убираются из чек-листа через
--     chats.excluded_from_qa=true (существующий механизм), а здесь заводится
--     read-only вью public.v_nonexistent_chats, чтобы дашборд/сводка могли
--     показать их в блоке «нет чатов у активных клиентов».
--
-- Данные исходных таблиц не трогаем; сами отметки (оверрайды и строки
-- nonexistent_chats) вносятся отдельными INSERT-ами, а не в этой DDL-миграции.

-- (A.1) Разрешаем новый статус 'absent' в оверрайдах ответственных.
alter table public.chat_responsibility_overrides
  drop constraint if exists chat_responsibility_overrides_status_check;
alter table public.chat_responsibility_overrides
  add constraint chat_responsibility_overrides_status_check
  check (status = any (array['not_required', 'present', 'absent']));

-- (B.1) Таблица «чат не существует» (ручная коррекция QA).
create table if not exists public.nonexistent_chats (
  chat_id    bigint primary key,
  chat_name  text,
  note       text,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.nonexistent_chats enable row level security;

-- (B.2) RLS-safe read-only вью (security definer, владелец postgres) — читается
-- любым ключом проекта, как и остальные вью дашборда.
create or replace view public.v_nonexistent_chats as
  select chat_id, chat_name, note, updated_at
  from public.nonexistent_chats;
alter view public.v_nonexistent_chats set (security_invoker = false);
grant select on public.v_nonexistent_chats to anon, authenticated;

-- (A.2) Пересоздаём вью ответственных. Отличие от миграции 007 — ТОЛЬКО в
-- выражении has_head_accountant: оверрайд 'absent' форсит false. Остальная
-- логика, столбцы и доступ без изменений.
create or replace view public.v_chat_missing_responsibles as
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
emp_ids as (
  select u.tg_id,
    bool_or(u.role = 'accountant')      as e_acc,
    bool_or(u.role = 'head_accountant') as e_head,
    bool_or(u.role = 'manager')         as e_mgr
  from (
    select telegram_id      as tg_id, role from public.employees where is_active and telegram_id is not null
    union
    select telegram_user_id as tg_id, role from public.employees where is_active and telegram_user_id is not null
  ) u
  group by u.tg_id
),
msg as (
  select m.chat_id,
    bool_or(m.sender_role = 'accountant'      or e.e_acc)  as m_acc,
    bool_or(m.sender_role = 'head_accountant' or e.e_head) as m_head,
    bool_or(m.sender_role = 'manager'         or e.e_mgr)  as m_mgr,
    count(*) as msg_rows,
    max(m.created_at) as last_msg_at
  from public.messages m
  left join emp_ids e on e.tg_id = m.sender_id
  group by m.chat_id
),
ovr as (
  select chat_id,
    max(status) filter (where role = 'accountant')      as o_acc,
    max(status) filter (where role = 'head_accountant') as o_head,
    max(status) filter (where role = 'manager')         as o_mgr,
    max(updated_at) as ovr_updated_at
  from public.chat_responsibility_overrides
  group by chat_id
),
-- Компания имеет одного главного бухгалтера на всех активных клиентов.
head_co as (
  select bool_or(is_active) as any_active_head
  from public.employees
  where role = 'head_accountant'
),
-- Назначения из Agreements (mqa_chats). Роль назначена, если поле непустое и не
-- плейсхолдер. chat_id берём из ссылки на чат (mqa_chats.chat_link, .../#-51439…).
agr as (
  select
    (regexp_replace(chat_link, '^.*#(-?\d+).*$', '\1'))::bigint as chat_id,
    bool_or(
      lower(btrim(coalesce(accountant, ''))) not in (
        '', '-', '—', '?', 'n/a', 'na', 'none', 'null', 'unknown', 'not set',
        'notset', 'tbd', 'нет', 'неизвестно', 'не указано', 'не указан',
        'не назначен', 'не назначено'
      )
    ) as a_acc,
    bool_or(
      lower(btrim(coalesce(manager, ''))) not in (
        '', '-', '—', '?', 'n/a', 'na', 'none', 'null', 'unknown', 'not set',
        'notset', 'tbd', 'нет', 'неизвестно', 'не указано', 'не указан',
        'не назначен', 'не назначено'
      )
    ) as a_mgr
  from public.mqa_chats
  where status = 'Active' and chat_link ~ '#-?\d+'
  group by 1
),
-- Присутствующие в чате менеджеры (активные сотрудники role='manager').
-- pref=2 для общего служебного аккаунта (@manager_onebusiness), pref=1 для
-- конкретных менеджеров — так конкретный менеджер выигрывает как владелец.
mgr_present as (
  select p.chat_id,
    e.id as emp_id,
    e.full_name,
    e.telegram_username,
    case when lower(coalesce(e.telegram_username, '')) = 'manager_onebusiness'
      then 2 else 1 end as pref
  from public.chat_employee_presence p
  join public.employees e on e.id = p.employee_id
  where p.employee_role = 'manager' and p.is_present and e.is_active
  group by p.chat_id, e.id, e.full_name, e.telegram_username
),
-- Один владелец на чат: сначала конкретный менеджер (pref=1), затем служебный
-- (pref=2); при равенстве — стабильно по имени и id (без двойного счёта).
owner_mgr as (
  select distinct on (chat_id)
    chat_id,
    emp_id            as owner_manager_id,
    full_name         as owner_manager_name,
    telegram_username as owner_manager_username
  from mgr_present
  order by chat_id, pref asc, full_name asc, emp_id asc
)
select
  c.chat_id,
  c.chat_name,
  coalesce(pr.p_acc,  false) or coalesce(mg.m_acc,  false)
    or coalesce(o.o_acc  = any (array['present','not_required']), false)
    or coalesce(a.a_acc, false)                                          as has_accountant,
  -- Оверрайд head_accountant='absent' форсит «нет главбуха» для этого чата,
  -- перекрывая общекомпанийного главбуха (head_co). Иначе — прежняя логика.
  case when o.o_head = 'absent' then false else
    coalesce(pr.p_head, false) or coalesce(mg.m_head, false)
    or coalesce(o.o_head = any (array['present','not_required']), false)
    or coalesce(hc.any_active_head, false)
  end                                                                    as has_head_accountant,
  coalesce(pr.p_mgr,  false) or coalesce(mg.m_mgr,  false)
    or coalesce(o.o_mgr  = any (array['present','not_required']), false)
    or coalesce(a.a_mgr, false)                                          as has_manager,
  coalesce(o.o_acc,  '') <> 'not_required' as req_accountant,
  coalesce(o.o_head, '') <> 'not_required' as req_head_accountant,
  coalesce(o.o_mgr,  '') <> 'not_required' as req_manager,
  -- checked теперь включает назначение в Agreements: присутствие ИЛИ сообщения
  -- ИЛИ роль назначена в Agreements (agr.a_acc / agr.a_mgr).
  (coalesce(pr.pres_rows, 0) > 0 or coalesce(mg.msg_rows, 0) > 0
    or coalesce(a.a_acc, false) or coalesce(a.a_mgr, false)) as checked,
  greatest(pr.pres_checked_at, mg.last_msg_at) as checked_at,
  -- Новые (аддитивные) столбцы — в конце, чтобы create or replace view не менял
  -- порядок/имена существующих столбцов.
  om.owner_manager_id,
  om.owner_manager_name,
  om.owner_manager_username
from public.chats c
left join pres pr on pr.chat_id = c.chat_id
left join msg  mg on mg.chat_id = c.chat_id
left join ovr  o  on o.chat_id  = c.chat_id
left join agr  a  on a.chat_id  = c.chat_id
left join owner_mgr om on om.chat_id = c.chat_id
cross join head_co hc
where c.is_active and not c.excluded_from_qa;

-- Сохраняем прежний доступ (RLS-safe), как после миграции 002.
alter view public.v_chat_missing_responsibles set (security_invoker = false);
grant select on public.v_chat_missing_responsibles to anon, authenticated;
