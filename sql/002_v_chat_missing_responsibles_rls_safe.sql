-- Аддитивная, только на чтение миграция (правит доступ к вью, не данные).
-- Применена к проекту OB FAQ (fjsogozwseqoxgddjeig).
--
-- Проблема: ежедневная сводка молча НЕ отправлялась.
--   scripts/daily-report.js сначала вызывает getProblemChats(), которая читает
--   public.v_chat_missing_responsibles. В миграции 001 эта вью была
--   намеренно закрыта: security_invoker=true + revoke от anon/authenticated,
--   т.е. читать её мог ТОЛЬКО service_role. Но крон на Render запускается не с
--   service_role-ключом, поэтому запрос падал с «permission denied for view
--   v_chat_missing_responsibles», исключение пробрасывалось, и (после того как
--   был убран короткий фолбэк) сводка не отправлялась вовсе.
--
-- Ровно эту же проблему для соседней вью public.v_mqa_active уже починили
-- (сделали её RLS-safe: security_invoker выключен => вью исполняется от владельца
-- postgres и обходит RLS; плюс выданы гранты anon/authenticated). Здесь делаем то
-- же самое для v_chat_missing_responsibles, чтобы обе вью читались любым ключом
-- проекта и цифры на дашборде и в Telegram совпадали.
--
-- Данные вью — только названия чатов и булевы флаги наличия ответственных; это
-- менее чувствительно, чем уже открытая для anon v_mqa_active (имена клиентов,
-- HVHH, ссылки на чаты). Само содержимое таблиц не меняется, доступ на запись не
-- выдаётся.

-- Исполнять вью от имени владельца (postgres), а не вызывающей роли — чтобы
-- обойти RLS исходных таблиц, как это уже сделано для v_mqa_active.
alter view public.v_chat_missing_responsibles set (security_invoker = false);

-- Разрешить чтение вью ролям PostgREST (крон/дашборд используют ключ проекта).
grant select on public.v_chat_missing_responsibles to anon, authenticated;
