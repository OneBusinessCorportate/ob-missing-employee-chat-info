-- Аддитивная миграция. Применяется к проекту OB FAQ (fjsogozwseqoxgddjeig).
--
-- Ручная коррекция данных Agreements для блоков дашборда «нет чатов у активных
-- клиентов», «нет HVHH в Agreements» и «чаты без ответственных». Источник этих
-- блоков — таблица public.mqa_chats (через вью public.v_mqa_active). Саму
-- mqa_chats НЕ трогаем (её наполняет внешняя синхронизация kk-сопровождения —
-- прямые правки затёрлись бы). Вместо этого заводим таблицу-накладку
-- public.mqa_chat_corrections (ключ — номер договора agr_no) и накладываем её
-- прямо во вью v_mqa_active через LEFT JOIN + COALESCE. Так исправления
-- применяются к уже задеплоенному дашборду сразу, без выката кода, и переживают
-- пересборку mqa_chats.
--
-- Что правим (по данным заказчика, чаты у клиентов ЕСТЬ, но ссылка не перенесена
-- в Agreements):
--   * chat_link  — реальная ссылка на Telegram-чат клиента (убирает из «нет чатов»);
--   * hvhh       — ИНН из колонки HVHH Agreements / Tax office (убирает из «нет HVHH»);
--   * accountant / manager — ответственные (убирает из «чаты без ответственных»);
--   * excluded   — полностью убрать клиента с дашборда (напр. чат в WhatsApp, не в TG).
--
-- Плюс две правки в «телеграм-мире» (вью v_chat_missing_responsibles) — они
-- вносятся отдельными INSERT/DELETE ниже, а не в DDL:
--   * Горц Ап (chat_id -1003949180777) убираем из nonexistent_chats — чат есть;
--   * ИП Полина Шилова (345717429): снимаем оверрайд head_accountant='absent'
--     (главбух Emiliya общекомпанийный присутствует) и ставим manager='present';
--   * B-4896 <Евгений Каличенко> (-5129318584): ставим manager='present' (Shogher).

-- (1) Таблица-накладка коррекций Agreements (ключ — номер договора).
create table if not exists public.mqa_chat_corrections (
  agr_no      text primary key,
  chat_link   text,
  hvhh        text,
  accountant  text,
  manager     text,
  excluded    boolean not null default false,
  note        text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table public.mqa_chat_corrections enable row level security;

-- (2) Пересоздаём v_mqa_active с накладкой коррекций. Набор и порядок столбцов
-- ИДЕНТИЧЕН прежнему (create or replace требует совпадения сигнатуры и не ломает
-- зависящие вью v_chat_sync_*). Отличия только в значениях (COALESCE с коррекцией)
-- и в фильтре excluded. mqa_chats при этом не изменяется.
create or replace view public.v_mqa_active as
select
  m.agr_no,
  coalesce(nullif(btrim(c.hvhh), ''), m.hvhh)             as hvhh,
  m.name_agr,
  m.name_tax,
  m.status,
  m.tax_activation_date,
  m.chat_name,
  coalesce(nullif(btrim(c.chat_link), ''), m.chat_link)   as chat_link,
  coalesce(nullif(btrim(c.accountant), ''), m.accountant) as accountant,
  coalesce(nullif(btrim(c.manager), ''), m.manager)       as manager,
  m.debts,
  m.created_date,
  coalesce(fn_canon_contract(m.agr_no), fn_canon_contract(m.chat_name)) as k_contract,
  fn_canon_name(m.chat_name)                                            as k_name
from public.mqa_chats m
left join public.mqa_chat_corrections c on c.agr_no = m.agr_no
where m.status = 'Active'::text
  and not coalesce(c.excluded, false);

-- Сохраняем прежний RLS-safe доступ (security definer, как после миграции 002).
alter view public.v_mqa_active set (security_invoker = false);
grant select on public.v_mqa_active to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Данные коррекций (идемпотентно). Заказчик подтвердил, что у этих клиентов чаты
-- есть; ссылки/HVHH/ответственные не были перенесены в Agreements.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.mqa_chat_corrections
  (agr_no, chat_link, hvhh, accountant, manager, excluded, note, updated_by)
values
  -- Горц Ап / АКАДЕМИЯ КАРЬЕРЫ И БИЗНЕСА & OneBusiness B-3031: чат есть
  -- (-4270129689, уже привязан), главбух Emiliya (общекомп.), бухгалтер Stella,
  -- менеджер manager_onebusiness.
  ('B-3031', null, null, null, 'manager_onebusiness', false,
   'Горц Ап / BCA: чат -4270129689 есть; менеджер manager_onebusiness, бухгалтер Stella, главбух Emiliya', 'info@onebusiness.am'),
  -- ARMOND YERUMYAN «Nikagold Capital Partners LLC»: чат в WhatsApp, не в
  -- Telegram — убрать с дашборда.
  ('1704', null, null, null, null, true,
   'ARMOND YERUMYAN (Nikagold): чат в WhatsApp, не в Telegram — убран с дашборда', 'info@onebusiness.am'),
  -- GLEB KOROLENKO / ИП Глеб Короленко: чат -4641712659; главбух Emiliya,
  -- менеджер manager_onebusiness, отдельного бухгалтера нет.
  ('1445', 'https://web.telegram.org/k/#-4641712659', null, null, 'manager_onebusiness', false,
   'GLEB KOROLENKO: чат -4641712659 есть; главбух Emiliya, менеджер manager_onebusiness, бухгалтера нет', 'info@onebusiness.am'),
  -- SIRVARD HAMBARDZUMYAN / ИП Сильва Амбарцумян: чат -4823075890; главбух
  -- Emiliya, роль бухгалтера/менеджера — manager_onebusiness.
  ('B-4071', 'https://web.telegram.org/k/#-4823075890', null, null, 'manager_onebusiness', false,
   'SIRVARD HAMBARDZUMYAN: чат -4823075890 есть; главбух Emiliya, менеджер manager_onebusiness', 'info@onebusiness.am'),
  -- TIGRAN AYVAZYAN / Тигран: чат -2706840536; главбух Emiliya (общекомп.).
  ('907', 'https://web.telegram.org/k/#-2706840536', null, null, null, false,
   'TIGRAN AYVAZYAN (Тигран): чат -2706840536 есть; главбух Emiliya', 'info@onebusiness.am'),
  -- VONABI LLC / Вонаби: чат -4958577175; HVHH 01058847 (из Tax office / HVHH
  -- check); бухгалтер Lilit @LilitAccounting, менеджер manager_onebusiness.
  ('SQA-VONABI', 'https://web.telegram.org/k/#-4958577175', '01058847', 'Lilit @LilitAccounting', 'manager_onebusiness', false,
   'VONABI LLC (Вонаби): чат -4958577175 есть; HVHH 01058847; бухгалтер Lilit @LilitAccounting, менеджер manager_onebusiness', 'info@onebusiness.am'),
  -- ИП Полина Шилова / B-0802 / RU: чат уже привязан (345717429); главбух
  -- Emiliya, бухгалтер Lilit, менеджер manager_onebusiness.
  ('B-0902', null, null, null, 'manager_onebusiness', false,
   'ИП Полина Шилова/B-0802/RU: главбух Emiliya, бухгалтер Lilit, менеджер manager_onebusiness', 'info@onebusiness.am')
on conflict (agr_no) do update set
  chat_link  = excluded.chat_link,
  hvhh       = excluded.hvhh,
  accountant = excluded.accountant,
  manager    = excluded.manager,
  excluded   = excluded.excluded,
  note       = excluded.note,
  updated_by = excluded.updated_by,
  updated_at = now();

-- Горц Ап: чат существует — снимаем ошибочную пометку «чат не существует».
delete from public.nonexistent_chats where chat_id = -1003949180777;

-- ИП Полина Шилова (345717429): главбух Emiliya присутствует (общекомпанийный) —
-- снимаем оверрайд head_accountant='absent'; менеджер manager_onebusiness есть.
delete from public.chat_responsibility_overrides
  where chat_id = 345717429 and role = 'head_accountant';
insert into public.chat_responsibility_overrides (chat_id, role, status, note, updated_by)
values (345717429, 'manager', 'present', 'ИП Полина Шилова: менеджер manager_onebusiness', 'info@onebusiness.am')
on conflict (chat_id, role) do update set status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();

-- B-4896 <Евгений Каличенко> ИП RU (-5129318584): менеджер Shogher присутствует.
insert into public.chat_responsibility_overrides (chat_id, role, status, note, updated_by)
values (-5129318584, 'manager', 'present', 'B-4896 Евгений Каличенко: менеджер Shogher', 'info@onebusiness.am')
on conflict (chat_id, role) do update set status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill HVHH из колонки HVHH (Agreements / налоговая) для активных клиентов,
-- у которых в mqa_chats ИНН пуст. Значения взяты по номеру договора из книги
-- Agreements. Клиенты, для которых HVHH в книге тоже отсутствует (прочерк),
-- сознательно НЕ добавляются — они остаются в списке «нет HVHH».
insert into public.mqa_chat_corrections (agr_no, hvhh, note, updated_by) values
  ('B-4145','23358147','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4452','73201423','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4809','00919987','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4816','08274346','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4817','20312405','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4818','20311629','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4825','20325357','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4830','49805996','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4832','01346533','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4847','20332997','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4864','02945183','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4875','02951864','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4804','20319229','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4821','20322621','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('B-4805','02307164','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am'),
  ('ООО Хойя Плейс/ B-4233 RU','08269432','HVHH из колонки HVHH (Agreements/налоговая)','info@onebusiness.am')
on conflict (agr_no) do update set hvhh = excluded.hvhh, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
