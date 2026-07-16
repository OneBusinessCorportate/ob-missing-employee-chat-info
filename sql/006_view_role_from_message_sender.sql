-- Аддитивная миграция: детект роли по АВТОРУ сообщения, а не только по
-- денормализованному sender_role. Применяется к проекту OB FAQ (fjsogozwseqoxgddjeig).
--
-- ПРОБЛЕМА (реальный баг детекта). Вью считала роль «писавшей» по полю
-- messages.sender_role, которое проставляется на этапе загрузки сообщений и
-- бывает неверным: активный сотрудник пишет в чат, а его сообщение помечено
-- чужой ролью или вовсе 'client' (ингестор не распознал его Telegram-аккаунт —
-- часто из-за дублей в справочнике employees). На данных проекта таких сообщений
-- 538 (178 помечены 'client') в 16 чатах — из-за них чат мог выглядеть «без
-- ответственного», хотя ответственный там реально писал.
--
-- РЕШЕНИЕ. Дополнительно сопоставляем messages.sender_id с активными
-- сотрудниками (employees.telegram_id / telegram_user_id) и берём их НАСТОЯЩУЮ
-- роль. Роль считается «писавшей», если так говорит sender_role ИЛИ автор —
-- активный сотрудник этой роли. Сопоставление предагрегируем по tg_id (emp_ids),
-- чтобы join не размножал строки сообщений.
--
-- Свойство прежнее: сигнал может только ПОДТВЕРДИТЬ присутствие роли (снять
-- ложный пропуск), но не создать новый. Только чтение; исходные таблицы не
-- меняются. Логика оверрайдов и folding not_required в has_* (миграции 004/005)
-- сохранены без изменений.

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
-- Активные сотрудники по их Telegram id (оба поля), с флагами ролей. Группируем
-- по tg_id, чтобы один и тот же id (дубли в employees) не размножал join.
emp_ids as (
  select tg_id,
    bool_or(role = 'accountant')      as e_acc,
    bool_or(role = 'head_accountant') as e_head,
    bool_or(role = 'manager')         as e_mgr
  from (
    select telegram_id      as tg_id, role from public.employees where is_active and telegram_id      is not null
    union
    select telegram_user_id as tg_id, role from public.employees where is_active and telegram_user_id is not null
  ) u
  group by tg_id
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
)
select
  c.chat_id,
  c.chat_name,
  -- has_* = «роль закрыта»: присутствует / писал (по sender_role ИЛИ по автору) /
  -- отмечена вручную present / роль не требуется (not_required).
  coalesce(pr.p_acc,  false) or coalesce(mg.m_acc,  false) or coalesce(o.o_acc  in ('present', 'not_required'), false) as has_accountant,
  coalesce(pr.p_head, false) or coalesce(mg.m_head, false) or coalesce(o.o_head in ('present', 'not_required'), false) as has_head_accountant,
  coalesce(pr.p_mgr,  false) or coalesce(mg.m_mgr,  false) or coalesce(o.o_mgr  in ('present', 'not_required'), false) as has_manager,
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

alter view public.v_chat_missing_responsibles set (security_invoker = false);
grant select on public.v_chat_missing_responsibles to anon, authenticated;
