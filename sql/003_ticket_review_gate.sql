-- 003 — Обработка вчерашних тикетов: атомарная запись согласия/апелляции.
--
-- Аддитивная миграция. НЕ создаёт новых таблиц и НЕ трогает бизнес-данные:
--   * не меняет chats / messages / chat_employee_presence / mqa_chats;
--   * не меняет сами строки public.kk_problems (правило read-only для исходных
--     проблем) — реакция бухгалтера пишется ТОЛЬКО в рабочие таблицы
--     public.kk_problem_acknowledgements («Принято») и public.kk_problem_appeals
--     («Апелляция»), которые уже существуют (мигр. 0025 соседнего приложения) и
--     на которых уже включён RLS.
--
-- Зачем функция: у Supabase REST нет многооператорной транзакции, а нам нужно
-- гарантировать, что один тикет НЕ окажется одновременно и «принят», и
-- «обжалован» одним бухгалтером, и что нет дублей — даже при гонке параллельных
-- запросов. Один вызов SQL-функции = одна транзакция. Мы блокируем строку тикета
-- (FOR SHARE) — это сериализует конкурентные «принять/апелляция» по одному
-- problem_id, а уникальные индексы (один ack на problem_id; одна ожидающая
-- апелляция на problem_id) добивают защиту от дублей на уровне БД.
--
-- Безопасность: SECURITY DEFINER + жёсткий search_path; EXECUTE выдаётся ТОЛЬКО
-- service_role (запись идёт исключительно с сервера под service-role-ключом).
-- Роли браузера (anon/authenticated) вызвать функцию не могут.

begin;

create or replace function public.kk_ticket_answer(
  p_problem_id      text,
  p_accountant_id   text,
  p_accountant_name text,
  p_action          text,            -- 'accept' | 'appeal'
  p_comment         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_problem   public.kk_problems%rowtype;
  v_has_ack   boolean;
  v_has_appeal boolean;
  v_owner     boolean;
  v_comment   text;
begin
  if p_action not in ('accept', 'appeal') then
    return jsonb_build_object('ok', false, 'error', 'bad_action');
  end if;

  -- Блокируем строку тикета на время транзакции: конкурентные ответы по одному
  -- problem_id выстроятся в очередь, а не создадут противоречие.
  select * into v_problem
    from public.kk_problems
    where problem_id = p_problem_id
    for share;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Владение: uuid совпал ИЛИ (защитно) совпало нормализованное имя. Нельзя
  -- отвечать за чужой тикет.
  v_owner :=
       (v_problem.accountant_id is not null and v_problem.accountant_id = p_accountant_id)
    or (p_accountant_name is not null
        and lower(btrim(v_problem.accountant_name)) = lower(btrim(p_accountant_name)));
  if not v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select exists(
    select 1 from public.kk_problem_acknowledgements where problem_id = p_problem_id
  ) into v_has_ack;
  select exists(
    select 1 from public.kk_problem_appeals
     where problem_id = p_problem_id
       and accountant_id is not distinct from p_accountant_id
  ) into v_has_appeal;

  if p_action = 'accept' then
    -- Нельзя принять уже обжалованный тикет (противоречие).
    if v_has_appeal then
      return jsonb_build_object('ok', false, 'error', 'already_appealed');
    end if;
    -- Уже принято — идемпотентный успех (без дубля).
    if v_has_ack then
      return jsonb_build_object('ok', true, 'status', 'accepted', 'duplicate', true);
    end if;
    insert into public.kk_problem_acknowledgements
      (problem_id, accountant_id, accountant_name, note)
    values
      (p_problem_id, p_accountant_id, p_accountant_name, p_comment)
    on conflict (problem_id) do nothing;
    return jsonb_build_object('ok', true, 'status', 'accepted');

  else -- appeal
    v_comment := btrim(coalesce(p_comment, ''));
    if v_comment = '' then
      return jsonb_build_object('ok', false, 'error', 'comment_required');
    end if;
    -- Нельзя обжаловать уже принятый тикет (противоречие).
    if v_has_ack then
      return jsonb_build_object('ok', false, 'error', 'already_accepted');
    end if;
    -- Уже подана апелляция — идемпотентный успех (без дубля).
    if v_has_appeal then
      return jsonb_build_object('ok', true, 'status', 'appealed', 'duplicate', true);
    end if;
    insert into public.kk_problem_appeals
      (problem_id, accountant_id, accountant_name, comment, status)
    values
      (p_problem_id, p_accountant_id, p_accountant_name, v_comment, 'pending');
    return jsonb_build_object('ok', true, 'status', 'appealed');
  end if;
end;
$$;

-- Запись только с сервера (service_role). Браузерные роли вызвать не могут.
revoke all on function public.kk_ticket_answer(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.kk_ticket_answer(text, text, text, text, text)
  to service_role;

commit;
