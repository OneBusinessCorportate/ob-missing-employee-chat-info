// metric-info.js — единый источник пояснений («тултипов») для дашбордов.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. На дашбордах много таблиц и «больших цифр», и не всегда
// очевидно, что за таблица перед вами, как посчитана каждая цифра, какие данные
// исключаются и почему. Здесь собраны короткие пояснения к КАЖДОМУ разделу,
// столбцу, блоку-цифре и строке. По ним можно пройтись и задать точечные
// вопросы. Пояснения показываются как всплывающие подсказки у значка ⓘ.
//
// ПРАВИЛО ОБНОВЛЕНИЯ (обязательно к соблюдению — см. AGENTS.md).
// Это единственный источник правды по смыслу цифр. Любое изменение логики
// расчёта — в lib/problemChats.js, lib/clientChecks.js, lib/clientCount.js или в
// соответствующих вью Supabase — обязано в ТОМ ЖЕ PR обновить текст здесь, чтобы
// подсказка всегда совпадала с формулой. Робот doc-sync блокирует мердж, если
// логика изменена, а этот файл — нет (форточка: метка PR `skip-tooltips`).
//
// КАК ДОБАВИТЬ ПОДСКАЗКУ В РАЗМЕТКУ.
//   1) На статичном элементе (заголовок, ярлык плитки, <th>) поставьте атрибут
//      data-info="<ключ>" — значок ⓘ добавится автоматически при загрузке.
//   2) В коде, который рисует строки/плитки, вставьте пустой якорь
//      <span data-info="<ключ>"></span> и вызовите MetricInfo.attach(контейнер),
//      либо добавьте элемент через MetricInfo.badge("<ключ>").

(function () {
  "use strict";

  // ---- Тексты пояснений. Ключ -> { title, body }. --------------------------
  // body может содержать несколько абзацев через "\n\n" и переносы "\n".
  const INFO = {
    // ===================== Дашборд «Проблемные чаты» =====================
    page_problems: {
      title: "Что это за страница",
      body:
        "Системный чек-лист (не отчёт о нарушениях): в каких рабочих Telegram-чатах клиентов не хватает ответственного — бухгалтера, главного бухгалтера или менеджера.\n\n" +
        "Источник — база OB FAQ (Supabase), вью v_chat_missing_responsibles. Она сводит три таблицы: chats (сами чаты), chat_employee_presence (кто состоит в чате и с какой ролью) и messages (кто в чате реально писал).\n\n" +
        "Проверяются только активные чаты (is_active = да) и не исключённые из проверки (excluded_from_qa = нет).",
    },
    presence_rule: {
      title: "Как определяется «ответственный есть»",
      body:
        "Роль считается закрытой, если человек этой роли ЛИБО состоит в чате (chat_employee_presence.is_present = да), ЛИБО хотя бы раз писал в чате (в messages есть сообщение с этой ролью).\n\n" +
        "Учёт сообщений добавлен намеренно: проверка членства у бота иногда падает («member not found»), а сообщение — твёрдое доказательство участия.",
    },
    stat_total: {
      title: "С неполной информацией",
      body:
        "Сколько проверенных чатов, где не хватает хотя бы одной из трёх ролей.\n\n" +
        "Формула: число чатов, у которых checked = да и missing_count > 0 (не хватает 1, 2 или 3 ролей). Это НЕ сумма трёх цифр справа — один чат может не иметь сразу нескольких ролей и в них считается один раз.",
    },
    stat_missing_accountant: {
      title: "Без бухгалтера",
      body:
        "Проверенные чаты, где нет присутствующего или писавшего бухгалтера (has_accountant = нет).\n\n" +
        "Нажмите на плитку — список отфильтруется по этому признаку. Плитки можно совмещать.",
    },
    stat_missing_head: {
      title: "Без главного бухгалтера",
      body:
        "Проверенные чаты, где нет присутствующего или писавшего главного бухгалтера (has_head_accountant = нет).",
    },
    stat_missing_manager: {
      title: "Без менеджера",
      body:
        "Проверенные чаты, где нет присутствующего или писавшего менеджера (has_manager = нет). Часто у таких чатов вообще не удалось определить менеджера-владельца.",
    },
    exclusions_problems: {
      title: "Что исключается и не считается проблемой",
      body:
        "• Тестовые/служебные чаты — по умолчанию всё, чьё название начинается на «test» (шаблон меняется через TEST_CHAT_PATTERN). Их число показано в подвале как «тестовых скрыто».\n" +
        "• Неактивные чаты (is_active = нет) и исключённые из проверки (excluded_from_qa = да) — во вью не попадают.\n" +
        "• Чаты без данных (бот ещё не в чате / сообщения не выгружены) — это «Не проверено». Про них неизвестно, есть ли ответственные, поэтому в проблемные они НЕ записываются, чтобы не было ложных тревог.",
    },
    notchecked: {
      title: "«Не проверено» — чаты без данных",
      body:
        "Чаты, по которым у нас нет данных: бот их ещё не проверял и сообщений нет (checked = нет). Мы не знаем, есть ли там ответственные, поэтому они вынесены отдельно и НЕ считаются проблемными.",
    },
    agr_section: {
      title: "Agreements — активные месячные клиенты",
      body:
        "Две дополнительные цифры про активных клиентов из мастер-листа Agreements. Те же значения уходят в ежедневную Telegram-сводку. Подробная сверка — на странице «Контроль клиентов».",
    },
    stat_no_hvhh: {
      title: "Нет HVHH в Agreements",
      body:
        "Активные месячные клиенты, у которых в Agreements не заполнен налоговый номер HVHH. Без HVHH клиента трудно однозначно сопоставить между источниками.",
    },
    stat_no_chat: {
      title: "Нет чатов у активных клиентов",
      body:
        "Активные месячные клиенты, у которых не найден рабочий Telegram-чат. Такой клиент есть в списке, но общения в Telegram у нас с ним нет.",
    },
    row_problem: {
      title: "Строка проблемного чата",
      body:
        "Один проверенный Telegram-чат, где не хватает хотя бы одной роли.\n\n" +
        "• Красные метки — какие именно роли отсутствуют.\n" +
        "• Chat ID — идентификатор чата (кнопкой можно скопировать; названия не уникальны).\n" +
        "• Менеджер — определённый владелец чата (по нему работает фильтр по менеджерам).\n" +
        "• «Открыть чат» — открывает этот чат в веб-Telegram.",
    },
    row_notchecked: {
      title: "Строка непроверенного чата",
      body:
        "Чат без данных: бот его не проверял и сообщений нет. Наличие ответственных неизвестно — поэтому чат не в проблемных, а здесь.",
    },
    row_client: {
      title: "Строка клиента Agreements",
      body:
        "Активный месячный клиент из мастер-листа. Метка показывает, чего не хватает — HVHH или чата. В подписи — № договора и/или HVHH, чтобы найти клиента в таблицах.",
    },

    // =================== Дашборд «Контроль клиентов» ====================
    page_clientcount: {
      title: "Что это за страница",
      body:
        "Сверка количества клиентов между всеми списками. Один клиент может быть записан в нескольких местах (договоры, One Business, лист «Чаты», рабочая система). Мы объединяем их в один список и показываем, у кого нет чата в Telegram или нет нашего бота.\n\n" +
        "Страница только читает данные — ничего не меняет и никуда не пишет.",
    },
    merge_rule: {
      title: "Как клиенты объединяются в один список",
      body:
        "Строки из всех источников склеиваются в одну компанию по СИЛЬНЫМ идентификаторам — HVHH (налоговый номер) и № договора. Одинаковые названия для склейки НЕ используются: два разных клиента могут называться одинаково, а у одного клиента бывает несколько договоров.\n\n" +
        "Только записи вообще без HVHH и без № договора склеиваются по нормализованному имени. Поэтому «всего компаний» обычно меньше суммы строк по всем источникам — дубликаты не считаются дважды.",
    },
    section_sources: {
      title: "1. Сколько клиентов в каждом списке",
      body:
        "По каждому источнику: сколько всего строк, сколько активных и сколько неактивных. Это НЕ уникальные клиенты — это размеры исходных списков (в них есть повторы). Объединённый и очищенный от дублей список — в разделах 2 и 6.",
    },
    col_src_total: {
      title: "Всего",
      body: "Число строк, прочитанных из этого источника (снимок xlsx или живой счётчик Supabase). С дублями, без объединения между источниками.",
    },
    col_src_active: {
      title: "Активные",
      body: "Строки со статусом «active». Для листа «Chats without bot» — где бот на месте (issue = ok).",
    },
    col_src_inactive: {
      title: "Неактивные",
      body: "Строки со статусом «inactive» (для Agreements сюда же входит «bad debt»; для One Business — «once»). Для отказников — весь список. Это и есть «негативные»/исключаемые из активных.",
    },
    gap: {
      title: "Почему цифры активных не совпадают",
      body:
        "Число активных по договорам, в рабочей системе и с привязанным чатом обычно различается — из-за дублей, незаполненного HVHH и клиентов без чата. Ниже (разделы 3–6) видно, из-за кого именно разница.",
    },
    section_universe: {
      title: "2. Все клиенты по статусу",
      body:
        "Все клиенты из всех списков, объединённые в один список без дублей, разложенные по статусу. Нажмите на карточку — внизу откроется список этих клиентов. Сумма карточек = всего компаний.",
    },
    class_active: {
      title: "Активные",
      body: "Где-то в источниках статус «active» И клиент НЕ отказник и НЕ именное исключение. Это «эффективно активные» — именно с ними работают разделы 3–4.",
    },
    class_inactive: {
      title: "Неактивные",
      body: "Статус «inactive» и нет активного статуса ни в одном источнике. В работу по чатам не берём.",
    },
    class_refusenik: {
      title: "Отказники",
      body: "Клиент есть в листе «Отказники» (ушёл/отказался). Всегда исключается из активных, даже если где-то ещё числится активным.",
    },
    class_exception: {
      title: "Исключения",
      body: "Имя клиента попадает в лист именных исключений (Exceptions: напр. Tabby / Agency). Такие клиенты сознательно исключены из проверки.",
    },
    class_once: {
      title: "Разовые",
      body: "Статус «once» — разовое обслуживание, не месячный клиент. Не активный на постоянной основе.",
    },
    class_bad_debts: {
      title: "Должники",
      body: "Статус содержит «bad debt». Не активный клиент.",
    },
    class_unknown: {
      title: "Непонятно",
      body: "Статус не распознан ни как active/inactive/once/bad debt, и клиент не отказник/исключение. Требует ручной проверки.",
    },
    negatives_clientcount: {
      title: "Что такое «негативные» и как они исключаются",
      body:
        "«Негативные» — это записи, которые НЕ считаются активными клиентами: отказники, именные исключения, а также статусы inactive / once / bad debt / непонятно.\n\n" +
        "Правило: клиент считается активным (effective_active) только если где-то у него статус «active» И он НЕ отказник и НЕ именное исключение. Отказники и исключения имеют приоритет — они убирают клиента из активных, даже если другой источник называет его активным.",
    },
    section_buckets: {
      title: "3. У всех ли активных клиентов есть чат",
      body:
        "Только эффективно активные клиенты, разложенные по тому, где с ними идёт общение. Сумма карточек = число активных клиентов. Нажмите на карточку — раздел 4 отфильтруется.",
    },
    bucket_in_bot: {
      title: "Всё хорошо — бот в чате",
      body: "Есть Telegram-чат, и наш бот в нём присутствует (по выгрузке аккаунта issue = ok). Действий не требуется.",
    },
    bucket_telegram_no_bot: {
      title: "Чат есть, но без бота",
      body: "Telegram-чат клиента найден в выгрузке аккаунта, но нашего бота в нём нет. Нужно добавить бота (см. раздел 5).",
    },
    bucket_other_channel: {
      title: "Не в Telegram (WhatsApp / почта)",
      body: "Общение идёт через WhatsApp или почту (по значению ссылки на чат). Нужно перевести общение в Telegram и добавить бота.",
    },
    bucket_chat_unclear: {
      title: "Непонятно, где чат",
      body: "Статус чата неясен (once / unknown / нет строки в выгрузке). Надо проверить, существует ли чат, и уточнить у менеджера.",
    },
    bucket_not_found: {
      title: "Чат нигде не найден",
      body: "Активный клиент, чат которого не найден ни в одном источнике. Искать по HVHH / № договора / имени, проверить mail и WhatsApp.",
    },
    section_actions: {
      title: "4. Что нужно сделать",
      body: "Активные клиенты с проблемой (из раздела 3, кроме «всё хорошо»), отсортированные по важности. Для каждого — где искать и что сделать. Можно фильтровать и выгрузить в CSV.",
    },
    col_hvhh: {
      title: "HVHH (налоговый номер)",
      body: "Налоговый номер клиента — самый надёжный идентификатор для сопоставления между списками. Может быть пустым, если в источниках его нет.",
    },
    col_agr: {
      title: "№ договора",
      body: "Номер договора — второй сильный идентификатор. Используется для склейки записей и поиска клиента в таблицах.",
    },
    col_problem: {
      title: "Проблема",
      body: "Тип проблемы из раздела 3: чат не найден, общение не в Telegram, чат без бота или статус чата непонятен.",
    },
    col_action_where: {
      title: "Где искать",
      body: "Подсказка, где искать чат/клиента: ссылка на чат, канал общения или идентификаторы (HVHH / договор).",
    },
    col_action_what: {
      title: "Что делать",
      body: "Конкретное действие: добавить бота, перенести общение в Telegram, проверить существование чата или найти клиента и написать Гарри.",
    },
    section_harry: {
      title: "Готовое сообщение для Гарри",
      body: "Короткая сводка одним сообщением: количество активных, разбивка по наличию чата/бота и число исключений. Кнопка копирует текст — можно вставить в чат.",
    },
    section_nobot: {
      title: "5. Чаты, в которые нужно добавить бота",
      body: "Чаты из выгрузки аккаунта (Эмилия / менеджеры), где по столбцу issue стоит «нет бота». Бота нужно добавить — иначе мы не видим, что в чате происходит. В скобках у заголовка — сколько ещё чатов со статусом once/unknown (спорные).",
    },
    section_all: {
      title: "6. Полный список всех клиентов",
      body: "Все компании из всех источников в одной таблице, объединённые без дублей. Галочка ✓ в последних столбцах показывает, в каком именно списке есть клиент. Для скорости показываются первые 1500 строк — уточните фильтр или выгрузите CSV.",
    },
    col_status: {
      title: "Статус",
      body: "Итоговый класс клиента: активный, неактивный, отказник, исключение, разовый, должник или непонятно (см. раздел 2).",
    },
    col_channel: {
      title: "Чат / канал",
      body: "Как идёт общение — определяется по ссылке на чат: Telegram, WhatsApp, почта, «нет чата», «не работаем» или «другое».",
    },
    col_bot: {
      title: "Бот",
      body: "Статус нашего бота в чате по выгрузке аккаунта: ok (на месте), no_bot (нет), once/unknown/unlisted (спорно), n_a (нет данных).",
    },
    col_src_ticks: {
      title: "В каком списке есть запись",
      body: "Галочка ✓ означает, что клиент присутствует в этом источнике: Дог. — договоры, OB — One Business, Чаты — лист «Чаты», Система — живые рабочие данные, Отказ — отказники.",
    },

    // ============ Общий вопрос про источники (xlsx vs Google) ============
    data_source_format: {
      title: "xlsx — это Google Таблицы?",
      body:
        "Нет. Приложение читает файлы Excel (.xlsx): «OB Agreements and Invoices…xlsx», «Чаты.xlsx», «One Business.xlsx». Прямого подключения к Google Sheets нет.\n\n" +
        "Порядок: таблицу ведут в Google Таблицах (или Excel) → выгружают как .xlsx → запускают scripts/extract-recon-sources.py, который читает xlsx и сохраняет снимки в data/recon/*.jsonl → снимки коммитятся в репозиторий.\n\n" +
        "Живые данные (активные клиенты, счётчики чатов) берутся отдельно из Supabase в реальном времени. Ничего обратно в xlsx/Google не записывается.",
    },
  };

  // ---- Стили значка и всплывающей подсказки. -------------------------------
  const CSS = `
    .mi-badge{display:inline-flex;align-items:center;justify-content:center;
      width:16px;height:16px;margin-left:6px;border-radius:50%;
      border:1px solid currentColor;color:#6b7280;background:transparent;
      font-size:11px;line-height:1;font-weight:700;font-style:normal;cursor:help;
      vertical-align:middle;flex:0 0 auto;user-select:none;opacity:.85;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
    .mi-badge:hover,.mi-badge:focus{color:#2563eb;opacity:1;outline:none;}
    .mi-badge:focus-visible{outline:2px solid #2563eb;outline-offset:2px;}
    @media (prefers-color-scheme: dark){ .mi-badge{color:#9aa0aa;} .mi-badge:hover,.mi-badge:focus{color:#60a5fa;} }
    .mi-pop{position:fixed;z-index:9999;max-width:320px;width:max-content;
      background:#111418;color:#f4f5f7;border:1px solid rgba(255,255,255,.14);
      border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.5;
      box-shadow:0 10px 30px rgba(0,0,0,.35);opacity:0;visibility:hidden;
      transition:opacity .12s ease;pointer-events:none;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      font-weight:400;text-transform:none;letter-spacing:normal;white-space:normal;}
    .mi-pop.mi-show{opacity:1;visibility:visible;pointer-events:auto;}
    .mi-pop .mi-title{font-weight:700;margin:0 0 4px;font-size:13px;}
    .mi-pop p{margin:0 0 6px;}
    .mi-pop p:last-child{margin-bottom:0;}
  `;

  function injectCss() {
    if (document.getElementById("mi-style")) return;
    const st = document.createElement("style");
    st.id = "mi-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // Единственный всплывающий элемент, переиспользуемый для всех значков.
  let pop = null;
  let activeBadge = null;
  let hideTimer = null;

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.className = "mi-pop";
    pop.setAttribute("role", "tooltip");
    pop.addEventListener("mouseenter", cancelHide);
    pop.addEventListener("mouseleave", scheduleHide);
    document.body.appendChild(pop);
    return pop;
  }

  function renderBody(info) {
    const p = ensurePop();
    const paras = String(info.body || "")
      .split("\n\n")
      .map((chunk) => {
        const t = document.createElement("p");
        // Переносы одиночной \n внутри абзаца — через <br>.
        const parts = chunk.split("\n");
        parts.forEach((line, i) => {
          if (i) t.appendChild(document.createElement("br"));
          t.appendChild(document.createTextNode(line));
        });
        return t;
      });
    p.innerHTML = "";
    if (info.title) {
      const h = document.createElement("div");
      h.className = "mi-title";
      h.textContent = info.title;
      p.appendChild(h);
    }
    paras.forEach((el) => p.appendChild(el));
  }

  function positionPop(badge) {
    const p = ensurePop();
    const r = badge.getBoundingClientRect();
    // Сначала показать невидимо, чтобы измерить размеры.
    p.style.left = "0px";
    p.style.top = "0px";
    const pr = p.getBoundingClientRect();
    const margin = 8;
    let left = r.left;
    if (left + pr.width + margin > window.innerWidth) {
      left = window.innerWidth - pr.width - margin;
    }
    if (left < margin) left = margin;
    let top = r.bottom + 6;
    if (top + pr.height + margin > window.innerHeight && r.top - pr.height - 6 > margin) {
      top = r.top - pr.height - 6; // не помещается снизу — показать сверху
    }
    p.style.left = Math.round(left) + "px";
    p.style.top = Math.round(top) + "px";
  }

  function showFor(badge) {
    const key = badge.getAttribute("data-mi-key");
    const info = INFO[key];
    if (!info) return;
    cancelHide();
    renderBody(info);
    ensurePop().classList.add("mi-show");
    positionPop(badge);
    activeBadge = badge;
  }

  function hideNow() {
    if (pop) pop.classList.remove("mi-show");
    activeBadge = null;
  }
  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(hideNow, 120);
  }
  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  // ---- Создание значка ⓘ. --------------------------------------------------
  // opts.interactive:
  //   true  (по умолчанию) — полноценный контрол: фокусируется с клавиатуры
  //          (role=button, tabindex). Годится в заголовках, ячейках <th>, тексте.
  //   false — НЕинтерактивный значок. Нужен, когда значок вкладывается ВНУТРЬ
  //          интерактивного предка (кнопки-плитки/ссылки): по стандарту HTML у
  //          <button> не может быть фокусируемых потомков и потомков с tabindex.
  //          Смысл плитки уже несёт её подпись; подробность доступна по наведению,
  //          тапу и через нативный title (значок скрыт от скринридеров).
  function makeBadge(key, opts) {
    opts = opts || {};
    const interactive = opts.interactive !== false;
    const info = INFO[key];
    if (!info) {
      // Явно сигналим о забытом ключе — помогает не рассинхронить формулу и текст.
      console.warn("[metric-info] нет пояснения для ключа:", key);
    }
    const b = document.createElement("span");
    b.className = "mi-badge";
    b.setAttribute("data-mi-key", key);
    b.textContent = "i";
    // Нативная подсказка-фолбэк: работает у всех при наведении, даже если JS-тултип
    // недоступен, и озвучивается вспомогательными технологиями на интерактивном значке.
    b.setAttribute(
      "title",
      info ? (info.title ? info.title + " — " : "") + info.body : key,
    );

    if (interactive) {
      b.setAttribute("role", "button");
      b.setAttribute("tabindex", "0");
      b.setAttribute("aria-label", "Пояснение: " + ((info && info.title) || key));
      b.addEventListener("focus", () => showFor(b));
      b.addEventListener("blur", hideNow);
      b.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          showFor(b);
        } else if (e.key === "Escape") {
          hideNow();
        }
      });
    } else {
      // Валидно внутри <button>/<a>: без role и tabindex, скрыт от скринридеров.
      b.setAttribute("aria-hidden", "true");
    }

    // Наведение и тап работают в обоих режимах.
    b.addEventListener("mouseenter", () => showFor(b));
    b.addEventListener("mouseleave", scheduleHide);
    // Клик/тап всегда ОТКРЫВАЕТ подсказку (без переключения). Иначе у
    // интерактивного значка возникает гонка: focus по клику уже показал тултип,
    // а следующий click закрыл бы его — и на тапе он моргал бы. Закрытие —
    // кликом вне значка, Escape, уводом курсора или потерей фокуса.
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // не запускать фильтр плитки под значком
      showFor(b);
    });
    return b;
  }

  // ---- Автопривязка к элементам с data-info. -------------------------------
  // Для каждого [data-info] (ещё не обработанного) добавляем значок как
  // последний потомок. Если у элемента нет текста (пустой якорь) — значок просто
  // встанет на его место.
  function attach(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll("[data-info]:not([data-mi-done])");
    nodes.forEach((node) => {
      node.setAttribute("data-mi-done", "1");
      const key = node.getAttribute("data-info");
      // Внутри кнопки/ссылки значок обязан быть неинтерактивным (валидность HTML).
      const interactive = !node.closest('button, a, [role="button"]');
      node.appendChild(makeBadge(key, { interactive: interactive }));
    });
  }

  // Глобальные обработчики: клик мимо и Escape — прячут подсказку.
  document.addEventListener("click", (e) => {
    if (activeBadge && !e.target.closest(".mi-badge") && !e.target.closest(".mi-pop")) hideNow();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideNow();
  });
  window.addEventListener("scroll", hideNow, true);
  window.addEventListener("resize", hideNow);

  function init() {
    injectCss();
    ensurePop();
    attach(document);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Публичный API для динамически создаваемых строк/плиток.
  window.MetricInfo = {
    INFO: INFO,
    text: (key) => INFO[key] || null,
    badge: makeBadge,
    attach: attach,
  };
})();
