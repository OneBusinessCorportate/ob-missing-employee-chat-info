-- Аддитивная, только на чтение миграция. Применена к проекту OB FAQ
-- (fjsogozwseqoxgddjeig).
--
-- Assignment-aware определение ответственных (вариант 2).
--
-- Раньше роль считалась «на месте» только по членству в Telegram
-- (chat_employee_presence) или по сообщению в чате. Новые клиентские чаты, в
-- которые назначенные люди ещё не зашли, помечались как «нет ответственного»,
-- хотя в реестре Agreements (mqa_chats) бухгалтер/менеджер указаны.
--
-- Теперь роль ТАКЖЕ закрыта, если она назначена в Agreements для этого клиента
-- (чат сопоставляется по chat_id из mqa_chats.chat_link). Это строго
-- аддитивно (OR): может лишь снять ложное «нет», но не создать новое. Главный
-- бухгалтер остаётся company-wide (один активный главбух закрывает всех).
-- «Назначен» = поле непустое и не плейсхолдер (нет / не указано / n/a / - / ? / …).
--
-- Меняем ТОЛЬКО определение вью; данные исходных таблиц не трогаем.

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
)
select
  c.chat_id,
  c.chat_name,
  coalesce(pr.p_acc,  false) or coalesce(mg.m_acc,  false)
    or coalesce(o.o_acc  = any (array['present','not_required']), false)
    or coalesce(a.a_acc, false)                                          as has_accountant,
  coalesce(pr.p_head, false) or coalesce(mg.m_head, false)
    or coalesce(o.o_head = any (array['present','not_required']), false)
    or coalesce(hc.any_active_head, false)                               as has_head_accountant,
  coalesce(pr.p_mgr,  false) or coalesce(mg.m_mgr,  false)
    or coalesce(o.o_mgr  = any (array['present','not_required']), false)
    or coalesce(a.a_mgr, false)                                          as has_manager,
  coalesce(o.o_acc,  '') <> 'not_required' as req_accountant,
  coalesce(o.o_head, '') <> 'not_required' as req_head_accountant,
  coalesce(o.o_mgr,  '') <> 'not_required' as req_manager,
  (coalesce(pr.pres_rows, 0) > 0 or coalesce(mg.msg_rows, 0) > 0) as checked,
  greatest(pr.pres_checked_at, mg.last_msg_at) as checked_at
from public.chats c
left join pres pr on pr.chat_id = c.chat_id
left join msg  mg on mg.chat_id = c.chat_id
left join ovr  o  on o.chat_id  = c.chat_id
left join agr  a  on a.chat_id  = c.chat_id
cross join head_co hc
where c.is_active and not c.excluded_from_qa;

-- Сохраняем прежний доступ (RLS-safe), как после миграции 002.
alter view public.v_chat_missing_responsibles set (security_invoker = false);
grant select on public.v_chat_missing_responsibles to anon, authenticated;
