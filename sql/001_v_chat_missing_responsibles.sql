-- Аддитивная, только на чтение миграция.
-- Одна строка на проверяемый чат с флагами наличия ответственных
-- (бухгалтер / гл. бухгалтер / менеджер) и признаком «реально проверялся».
-- Ничего в существующих таблицах не меняет. Применена к проекту OB FAQ
-- (fjsogozwseqoxgddjeig).
--
-- Логика:
--   * База — активные, не исключённые из QA чаты (chats).
--   * Роль «на месте», если человек этой роли ПРИСУТСТВУЕТ по проверке членства
--     (chat_employee_presence.is_present) ИЛИ реально писал в чат
--     (messages.sender_role). Сообщения — твёрдое доказательство участия, а
--     проверка членства иногда сбоит (member not found и т.п.).
--   * checked = по чату есть данные (присутствие или сообщения). Чаты без данных
--     (напр. импортированные kk_import, куда бот ещё не зашёл) не считаются
--     «без ответственных» — они «не проверены».

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
)
select
  c.chat_id,
  c.chat_name,
  coalesce(pr.p_acc,  false) or coalesce(mg.m_acc,  false) as has_accountant,
  coalesce(pr.p_head, false) or coalesce(mg.m_head, false) as has_head_accountant,
  coalesce(pr.p_mgr,  false) or coalesce(mg.m_mgr,  false) as has_manager,
  (coalesce(pr.pres_rows, 0) > 0 or coalesce(mg.msg_rows, 0) > 0) as checked,
  greatest(pr.pres_checked_at, mg.last_msg_at) as checked_at
from public.chats c
left join pres pr on pr.chat_id = c.chat_id
left join msg  mg on mg.chat_id = c.chat_id
where c.is_active and not c.excluded_from_qa;

-- Вью уважает RLS исходных таблиц для вызывающей роли (service_role читает всё,
-- anon/authenticated — по политикам таблиц) и напрямую не доступна публичным
-- ролям через PostgREST.
alter view public.v_chat_missing_responsibles set (security_invoker = true);
revoke all on public.v_chat_missing_responsibles from anon, authenticated;
