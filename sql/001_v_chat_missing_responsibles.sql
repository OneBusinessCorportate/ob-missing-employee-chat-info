-- Аддитивная, только на чтение миграция.
-- Создаёт вью с одной строкой на проверяемый чат и флагами наличия
-- ответственных (бухгалтер / гл. бухгалтер / менеджер). Ничего в существующих
-- таблицах не меняет. Применена к проекту OB FAQ (fjsogozwseqoxgddjeig).

create or replace view public.v_chat_missing_responsibles as
select
  c.chat_id,
  c.chat_name,
  coalesce(bool_or(p.employee_role = 'accountant'      and p.is_present), false) as has_accountant,
  coalesce(bool_or(p.employee_role = 'head_accountant' and p.is_present), false) as has_head_accountant,
  coalesce(bool_or(p.employee_role = 'manager'         and p.is_present), false) as has_manager,
  max(p.checked_at) as checked_at
from public.chats c
left join public.chat_employee_presence p on p.chat_id = c.chat_id
where c.is_active and not c.excluded_from_qa
group by c.chat_id, c.chat_name;

-- Вью уважает RLS исходных таблиц для вызывающей роли (service_role читает всё,
-- anon/authenticated — по политикам таблиц), и напрямую не доступна публичным
-- ролям через PostgREST.
alter view public.v_chat_missing_responsibles set (security_invoker = true);
revoke all on public.v_chat_missing_responsibles from anon, authenticated;
