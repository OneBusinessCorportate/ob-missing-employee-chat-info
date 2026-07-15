-- Аддитивная миграция для обязательного разбора «вчерашних» тикетов.
-- Ничего не меняет в существующих бизнес-таблицах (kk_problems, chats, messages,
-- chat_employee_presence, mqa_chats). Добавляет ТОЛЬКО серверную функцию для
-- атомарной записи ответа бухгалтера (принять / апелляция) и — на всякий случай,
-- идемпотентно — гарантирует наличие ограничений уникальности, которые уже
-- присутствуют в проекте OB FAQ. Применяется к проекту OB FAQ (fjsogozwseqoxgddjeig).
--
-- Рабочие таблицы (уже существуют, RLS включён):
--   kk_problem_acknowledgements(problem_id, accountant_id, accountant_name, note, ...)
--   kk_problem_appeals(problem_id, accountant_id, accountant_name, comment, status, source, ...)
--
-- Ответы пишутся ТОЛЬКО в эти таблицы. Строки kk_problems не изменяются.

-- 1) Идемпотентно подтверждаем ограничения дедупликации (обычно уже есть):
--    * не более одного подтверждения на тикет;
--    * не более одной ДЕЙСТВУЮЩЕЙ (pending) апелляции на тикет.
create unique index if not exists kk_prob_ack_problem_uniq
  on public.kk_problem_acknowledgements (problem_id);

create unique index if not exists kk_prob_appeals_one_pending
  on public.kk_problem_appeals (problem_id)
  where status = 'pending';

-- 2) Атомарная запись ответа бухгалтера.
--    Взаимоисключение «принять» и «апелляция» на один тикет и защита от гонок
--    обеспечиваются транзакционной advisory-блокировкой по problem_id — сами
--    строки kk_problems при этом НЕ изменяются и НЕ блокируются на запись.
--    Все проверки (владелец/срок/статус/комментарий) дублируются на сервере
--    (lib/ticketReview.js validateAnswer), здесь — последний барьер целостности.
create or replace function public.kk_review_submit(
  p_problem_id     text,
  p_accountant_id  text,
  p_accountant_name text,
  p_action         text,          -- 'accept' | 'appeal'
  p_comment        text,
  p_range_start    timestamptz,
  p_range_end      timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_problem   public.kk_problems%rowtype;
  v_business_ts timestamptz;
  v_has_ack    boolean;
  v_has_appeal boolean;
  v_comment    text;
begin
  if p_action not in ('accept', 'appeal') then
    raise exception 'BAD_ACTION';
  end if;

  -- Сериализуем операции по одному тикету, не трогая строку kk_problems.
  perform pg_advisory_xact_lock(hashtext(p_problem_id));

  select * into v_problem from public.kk_problems where problem_id = p_problem_id;
  if not found then
    raise exception 'TICKET_NOT_FOUND';
  end if;

  if v_problem.accountant_id is distinct from p_accountant_id then
    raise exception 'NOT_OWNER';
  end if;

  v_business_ts := coalesce(v_problem.detected_at, v_problem.created_at);
  if p_range_start is not null and v_business_ts < p_range_start then
    raise exception 'OUT_OF_RANGE';
  end if;
  if p_range_end is not null and v_business_ts >= p_range_end then
    raise exception 'OUT_OF_RANGE';
  end if;

  if v_problem.status not in ('new', 'waiting_for_accountant', 'returned_to_accountant') then
    raise exception 'NOT_ELIGIBLE';
  end if;

  select exists(
    select 1 from public.kk_problem_acknowledgements where problem_id = p_problem_id
  ) into v_has_ack;
  select exists(
    select 1 from public.kk_problem_appeals where problem_id = p_problem_id and status <> 'rejected'
  ) into v_has_appeal;

  if p_action = 'accept' then
    if v_has_appeal then raise exception 'ALREADY_APPEALED'; end if;
    if v_has_ack then
      return jsonb_build_object('status', 'already', 'action', 'accept');
    end if;
    v_comment := nullif(btrim(coalesce(p_comment, '')), '');
    insert into public.kk_problem_acknowledgements (problem_id, accountant_id, accountant_name, note)
      values (p_problem_id, p_accountant_id, p_accountant_name, v_comment);
    return jsonb_build_object('status', 'ok', 'action', 'accept');

  else -- appeal
    v_comment := btrim(coalesce(p_comment, ''));
    if v_comment = '' then raise exception 'COMMENT_REQUIRED'; end if;
    if v_has_ack then raise exception 'ALREADY_ACCEPTED'; end if;
    if v_has_appeal then
      return jsonb_build_object('status', 'already', 'action', 'appeal');
    end if;
    insert into public.kk_problem_appeals
      (problem_id, accountant_id, accountant_name, comment, status, source)
      values (p_problem_id, p_accountant_id, p_accountant_name, v_comment, 'pending', 'mandatory_review');
    return jsonb_build_object('status', 'ok', 'action', 'appeal');
  end if;
end;
$$;

-- Доступ к функции. Сервис-ключ и так обходит RLS; гранты — для единообразия с
-- уже открытыми на запись рабочими таблицами ack/appeals.
grant execute on function public.kk_review_submit(
  text, text, text, text, text, timestamptz, timestamptz
) to anon, authenticated, service_role;
