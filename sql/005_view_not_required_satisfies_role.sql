-- Аддитивная миграция: делает вью v_chat_missing_responsibles устойчивой к
-- потребителям, которые читают только has_* (без req_*). Применяется к проекту
-- OB FAQ (fjsogozwseqoxgddjeig).
--
-- ПРОБЛЕМА. Миграция 004 добавила оверрайды и флаги req_* («требуется ли роль»),
-- а «не хватает» стало считаться как req AND NOT has. Но задеплоенный дашборд/крон
-- мог ещё работать на СТАРОМ коде, который читает только has_accountant/… и
-- считает missing = NOT has. Для оверрайда status='present' это ок (он уже
-- поднимает has_*), а вот status='not_required' старый код не видел — и чат с
-- «ролью не требуется» продолжал висеть как проблемный до выката нового кода.
--
-- РЕШЕНИЕ. Трактуем has_* как «роль ЗАКРЫТА» (кто-то её выполняет ЛИБО она не
-- требуется). Тогда not_required тоже поднимает has_*, и старый код (missing =
-- NOT has) сразу даёт правильные цифры, а новый (missing = req AND NOT has)
-- остаётся согласованным: при not_required req=false и has=true — оба пути дают
-- «не проблема». req_* сохраняем как явный признак «роль не требуется» на будущее
-- (напр. отдельная отметка на дашборде), поведение он не меняет.
--
-- Ничего в исходных таблицах не меняется; правило прежнее — оверрайд может только
-- СНЯТЬ ложную проблему, но не создать новую.

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
  -- has_* = «роль закрыта»: присутствует / писал в чат / отмечена вручную present
  -- / роль вообще не требуется (not_required). coalesce(... in (...), false)
  -- обязателен: при отсутствии оверрайда o_* = NULL, а `false OR NULL` дал бы NULL.
  coalesce(pr.p_acc,  false) or coalesce(mg.m_acc,  false) or coalesce(o.o_acc  in ('present', 'not_required'), false) as has_accountant,
  coalesce(pr.p_head, false) or coalesce(mg.m_head, false) or coalesce(o.o_head in ('present', 'not_required'), false) as has_head_accountant,
  coalesce(pr.p_mgr,  false) or coalesce(mg.m_mgr,  false) or coalesce(o.o_mgr  in ('present', 'not_required'), false) as has_manager,
  -- req_* = «роль требуется» (нет оверрайда not_required). Только для наглядности.
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
