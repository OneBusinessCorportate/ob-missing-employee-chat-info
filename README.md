# ob-missing-employee-chat-info

A tiny **system checklist** platform for client Telegram chats that are missing
a responsible person (Accountant / Head Accountant / Manager).

This is **not** an employee-violation report — it is a technical checklist, like
the old Google Sheet, so the whole team can see all mismatches in one place.

It has two parts:

1. **Dashboard** (`server.js` + `public/`) — a clean, mobile-friendly web page
   listing every problematic chat, what it is missing, and its Chat ID.
   Protected by a shared-password login, with role filters, name/Chat-ID search,
   sorting, CSV export, copy-Chat-ID, manual refresh and a "last checked"
   timestamp.
2. **Daily Telegram summary** (`scripts/daily-report.js`) — posts only a short
   summary + a link to the dashboard. It never posts the full list.
   Sends with retry/backoff, structured JSON logs and optional idempotency.

Both share `lib/problemChats.js`, so the counts in Telegram always match the
dashboard. Auth + rate limiting live in `lib/auth.js`.

## Data source

The checklist reads the **real** chat/responsibility data in the **OB FAQ**
Supabase project (`fjsogozwseqoxgddjeig`):

- **`public.chats`** — the Telegram chats (`chat_id`, `chat_name`, `is_active`,
  `excluded_from_qa`). Only `is_active AND NOT excluded_from_qa` chats are checked.
- **`public.chat_employee_presence`** — the membership check: who is present in
  each chat, with `employee_role` (`accountant` / `head_accountant` / `manager` /
  …) and `is_present`.
- **`public.messages`** — actual messages, each with a `sender_role`. If a staff
  member of a role has written in the chat, that role is treated as present too
  (hard evidence of participation — the bot's membership check occasionally fails
  with "member not found" and similar). To fix those failures at the source you
  can refresh membership with a Telegram **user account** — see
  [Refreshing presence via a Telegram user account](#refreshing-presence-via-a-telegram-user-account-phone-login).

A read-only view **`public.v_chat_missing_responsibles`** aggregates these into
one row per chat with `has_accountant` / `has_head_accountant` / `has_manager`
(presence **or** message activity), a `checked` flag and `checked_at`. The app
selects from that view (server-side, with the service role key).
See [Migrations](#migrations).

**Checked vs not checked.** A chat is `checked` when we actually have data for it
(a membership check ran, or there are messages). Chats with **no data at all**
(e.g. `kk_import` chats the bot has not joined yet) are reported separately as
"не проверено" and are **not** counted as missing a responsible — otherwise every
un-ingested chat would look like it is missing all three roles. This is why the
totals (≈ 677 checked / 183 problematic) are lower and more accurate than a naive
presence-only count (which showed ≈ 235, inflated by ~50 un-checked chats and by
missing the message signal).

> The older `public.client_telegram_chats` table (participants jsonb) held only
> QA/test rows and is **not** used anymore.

## Daily client/chat check block (Agreements)

The daily Telegram summary appends a compact, **additive** `dop info:` block,
built from the Agreements / kk-сопровождение table **`public.mqa_chats`** (one
row per client-agreement, also exposed as `public.v_mqa_active` for
`status='Active'`). It reads only real data, matches nothing across tables
(everything it needs is in one row), and never writes. Logic lives in
`lib/clientChecks.js`; the message is rendered by `buildClientChecksBlock` in
`scripts/daily-report.js`. The full message looks like:

```text
У нас есть 18 проблемных чатов, из которых:

14 без бухгалтера
1 без главного бухгалтера
5 без менеджера
29 нет HVHH в Agreements
15 нет чатов у активных месячных клиентов

Чтобы увидеть больше информации, перейдите по ссылке:
https://ob-missing-employee-chat-info.onrender.com/

Доп. информация:
Нет HVHH в Agreements: 29
Нет чатов у активных месячных клиентов: 15
```

The two Agreements metrics appear both inline in the "из которых" list and,
for readability, again under the `Доп. информация:` (dop info) footer.

Only **active** clients (`status='Active'`) are considered — these are the active
monthly service clients. The `dop info:` block reports two counts:

| Line                                       | Meaning (per active client)                                            |
| ------------------------------------------ | --------------------------------------------------------------------- |
| Нет HVHH в Agreements                      | `hvhh` is empty                                                        |
| Нет чатов у активных месячных клиентов      | `chat_link` is empty (no Telegram chat)                               |

The full per-client detail is left on the dashboard (`PLATFORM_URL`, linked once
above). `computeClientChecks` also computes a "chats without a responsible"
(`accountant`/`manager` empty) list and a **Needs review** bucket for rows with no
usable identifier — these are kept out of the compact message (they are available
for the dashboard / logs), since "chats without a responsible" is already covered
by the main report above.

The rest of the report — the responsibles checklist, SLA, filters and AI
analysis — is **unchanged** apart from the reworded summary line; the `dop info:`
block is purely appended.

## What counts as a "problem"

A chat is problematic when it is missing **at least one** of these roles:

| Role            | "Missing" means… (for a **checked** chat)                            |
| --------------- | ------------------------------------------------------------------- |
| Accountant      | no `accountant` is present *and* none has written in the chat        |
| Head Accountant | no `head_accountant` is present *and* none has written in the chat   |
| Manager         | no `manager` is present *and* none has written in the chat           |

The dashboard and summary report:

- how many chats were checked (`is_active`, not excluded from QA),
- how many have incomplete info (missing ≥1 role),
- how many are missing an Accountant / Head Accountant / Manager.

(A chat missing two roles is counted once in the total and once under each role
it is missing, so the per-role numbers can add up to more than the total.)

### Test chats are excluded

QA/test chats (e.g. `testchat67`) are filtered out so the checklist only shows
real client chats. By default any chat whose name starts with `test`
(case-insensitive) is excluded from the list **and** the counts; the number
hidden is shown as "тестовых скрыто".

- `EXCLUDE_TEST_CHATS=0` — turn the filter off (show everything, matching the
  raw daily report).
- `TEST_CHAT_PATTERN` — override the regex (e.g. `^(test|qa)-`).

## Tests

```bash
npm test        # node:test — covers computeProblems, auth, the daily message
```

Coverage includes: all roles present, each role missing, multiple missing, no
presence rows at all, `chat_id` normalisation, duplicate-name detection,
test-chat exclusion (default, custom pattern), the counts, and a regression that
reproduces real report verdicts. CI runs the same suite on every push/PR
(`.github/workflows/ci.yml`).

## Running locally

```bash
npm install
cp .env.example .env      # fill in the values
npm start                 # dashboard on http://localhost:3000
npm run daily-report      # send the daily summary (use DRY_RUN=1 to preview)
npm run telegram-login    # one-time: log in by phone, get the session string
npm run telegram-sync     # refresh presence from real Telegram membership
```

`DRY_RUN=1 npm run daily-report` prints the message instead of sending it.
`DRY_RUN=1 npm run telegram-sync` scans Telegram and reports what it *would*
write, without touching Supabase.

## Environment variables

| Variable                    | Used by            | Notes                                                        |
| --------------------------- | ------------------ | ----------------------------------------------------------- |
| `SUPABASE_URL`              | dashboard + report | Defaults to the OB FAQ URL.                                 |
| `SUPABASE_SERVICE_ROLE_KEY` | dashboard + report | **Required.** Service role key (kept server-side only).      |
| `ACCESS_PASSWORD`           | dashboard          | Shared login password. If unset, the dashboard is **open** (dev only) — set it in production. |
| `SESSION_SECRET`            | dashboard          | Optional. HMAC secret for the session cookie; derived from `ACCESS_PASSWORD` if unset. |
| `NODE_ENV`                  | dashboard          | Set to `production` on Render so the session cookie is `Secure`. |
| `EXCLUDE_TEST_CHATS`        | dashboard + report | `0` to show test chats too. Default: exclude them.          |
| `TEST_CHAT_PATTERN`         | dashboard + report | Optional regex for what counts as a test chat (default `^test`). |
| `TELEGRAM_BOT_TOKEN`        | report             | Bot that posts the daily summary.                           |
| `TELEGRAM_CHAT_ID`          | report             | Chat/group the summary is posted to.                        |
| `PLATFORM_URL`              | report             | Public dashboard URL — the link inside the Telegram message.|
| `TELEGRAM_API_ID`           | telegram-sync      | MTProto **api_id** from my.telegram.org (user-account sync).|
| `TELEGRAM_API_HASH`         | telegram-sync      | MTProto **api_hash** from my.telegram.org.                  |
| `TELEGRAM_SESSION`          | telegram-sync      | Session string from `npm run telegram-login`. **Secret** — full account access. |
| `SYNC_ALL_CHATS`            | telegram-sync      | `1` to write presence for every group the account is in (default: only chats in `public.chats`). |
| `SYNC_CHAT_LIMIT`           | telegram-sync      | Optional. Process at most N groups (debugging).             |
| `PORT`                      | dashboard          | Render sets this automatically.                             |
| `DRY_RUN`                   | report             | `1` to print instead of send.                              |
| `REPORT_STATE_FILE`         | report             | Optional. Path to a JSON file so the summary is not sent twice in one day. |

## Access control

The dashboard is behind a lightweight shared-password gate (no extra Supabase
tables, no dependencies): the user enters `ACCESS_PASSWORD` once on `/login`,
the server sets a signed **HttpOnly** cookie (HMAC, 30-day TTL), and every
request is checked against it. `/healthz` stays public for Render. The
`/api/problem-chats` and login endpoints are rate-limited in memory
(60/min and 10/min per IP). If `ACCESS_PASSWORD` is not set the gate is
disabled and the server logs a warning — **always set it in production.**

The underlying tables have Row Level Security enabled. The dashboard reads them
**server-side with the service role key** and exposes a read-only
`/api/problem-chats` endpoint; the browser never sees the key or talks to
Supabase directly.

## Where the platform link is configured

The link that goes into the Telegram message is the **`PLATFORM_URL`** env var
on the daily-report cron job. After the dashboard is deployed, set `PLATFORM_URL`
to its public URL (e.g. `https://ob-chat-checklist-dashboard.onrender.com`).

## How chats / roles are maintained

Chat and responsibility data is produced by the existing OB pipeline that fills
`public.chats` and `public.chat_employee_presence`; this project only **reads**
them (via the view) and never writes. To change what shows up:

- exclude a chat → set `excluded_from_qa = true` (or `is_active = false`) on the
  `public.chats` row;
- fix a "missing role" → make sure the responsible person has an
  `chat_employee_presence` row for that `chat_id` with the right `employee_role`
  and `is_present = true`.

### Manual overrides (`chat_responsibility_overrides`)

Two real cases could not be expressed by presence/`excluded_from_qa` alone, so
operators kept fixing them by hand while the checklist re-flagged the chat every
day. The additive table `public.chat_responsibility_overrides` (migration
`sql/004_chat_responsibility_overrides.sql`) fixes both, per `(chat_id, role)`:

| `status`       | Meaning                                                        | Effect on the view                     |
| -------------- | ------------------------------------------------------------- | -------------------------------------- |
| `not_required` | This role is **not needed** for this chat (e.g. "бухгалтер не должен быть в этом чате"). | Role dropped from "required" → never counted as missing. |
| `present`      | The responsible **is** in the chat but the check can't see them (bot membership failed, or the employee is `is_active=false` so the sync skips them). | Role treated as covered, same as a real presence/message signal. |

The view treats `has_*` as "**role satisfied**" — someone fills it, *or* it is
marked `not_required` — and also exposes `req_accountant / req_head_accountant /
req_manager` for the explicit "not required" state. A role is "missing" only when
it is **required and not satisfied** (`missing = required AND NOT has`; folding
`not_required` into `has_*` also keeps older consumers that read only `has_*`
correct — see `sql/005`). Like the Telegram sync, an override can only *clear* a
false problem — never invent one. Overrides are durable and reversible (delete the
row). Add/adjust one with:

```sql
insert into public.chat_responsibility_overrides (chat_id, role, status, note, updated_by)
values (-4767514206, 'accountant', 'present', 'Aida = бухгалтер', 'you@onebusiness.am')
on conflict (chat_id, role) do update
  set status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
```

### The dashboard auto-refreshes

`public/index.html` re-reads `/api/problem-chats` every 60 s (and immediately
when the tab regains focus), so edits — overrides, a fresh presence sync — show
up without pressing **↻ Обновить**. The daily Telegram summary and the dashboard
read the **same** live view, so their counts match by construction (the summary
is a once-a-day snapshot; the dashboard is always current).

## Refreshing presence via a Telegram **user account** (phone login)

The presence data (`chat_employee_presence`) was originally filled by a **bot**
using the Bot API. The Bot API can only check membership one user at a time
(`getChatMember`) and fails constantly — the table is full of statuses like
`member not found`, `chat not found`, `PARTICIPANT_ID_INVALID` and
`bot was kicked from the group chat`. Every such failure becomes a false
`is_present = false`, so a chat looks like it is "missing a responsible" when the
person is actually there.

A **user account** (logged in by phone number via MTProto — exactly the
`my.telegram.org` → `api_id`/`api_hash` flow) can do what a bot cannot: read the
**full participant list** of every group it belongs to. This project ships a
sync that uses that to write authoritative presence rows.

It is written in **Node with [GramJS](https://github.com/gram-js/gram-js)** (the
Node equivalent of Telethon/Pyrogram) so it lives in the same codebase, reuses
the same Supabase client, and deploys as another Render cron job.

### One-time setup

1. Go to **my.telegram.org** → log in with your Telegram phone number →
   **API development tools** → **Create application**. Copy the **`api_id`** and
   **`api_hash`**.
2. Put them in the environment and log in once to mint a session string:

   ```bash
   TELEGRAM_API_ID=1234567 TELEGRAM_API_HASH=your-api-hash npm run telegram-login
   ```

   It asks for your **phone number**, the **code** Telegram sends you, and your
   **2FA password** if you have one — then prints a **session string**.
3. Save that string as **`TELEGRAM_SESSION`** (locally in `.env`; on Render as a
   secret env var, `sync: false`). It is equivalent to full access to the
   account — never commit it or paste it anywhere public.

#### Logging in on Render (no local machine needed)

`npm run telegram-login` is **interactive** — it waits for the code you type.
So it will **not** work as a cron job (nothing types the code, it just hangs and
dies "halfway"). If you don't want to run it locally, use the built-in
**browser login** instead — it runs on the always-on web service, so the Telegram
connection stays alive between steps and can't drop mid-flow:

1. Deploy this branch, and on the **dashboard** web service set env vars
   `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `TELEGRAM_LOGIN_ENABLED=1`
   (and make sure `ACCESS_PASSWORD` is set — the page is behind the login gate).
2. Open **`/telegram-login`** on the dashboard URL, enter phone → code → 2FA.
   The page shows the **session string** at the end.
3. Copy it into **`TELEGRAM_SESSION`** on the `ob-chat-checklist-telegram-sync`
   cron job, then **remove `TELEGRAM_LOGIN_ENABLED`** so the page is disabled
   again.

The page is off unless `TELEGRAM_LOGIN_ENABLED=1`, requires dashboard login, and
is rate-limited. Turn it off once you have the session string.

### Running the sync

```bash
npm run telegram-sync            # writes presence to Supabase
DRY_RUN=1 npm run telegram-sync  # scan only, report what it would write
```

For each group the account is in, the sync fetches all participants, matches
them to `public.employees` (by Telegram id first, then `@username`) and upserts
`chat_employee_presence` rows with `is_present = true` (conflict target
`(chat_id, employee_id)`). Group ids are converted to the same signed Bot-API
form the tables use (e.g. `-1002954615886`) via GramJS's `getPeerId`.

**Safety by design:** the sync only ever asserts **presence** (`is_present =
true`) for people it actually sees in a group. It never writes `is_present =
false`, so it can only *clear* a false "missing responsible" — it can never
create a new one. By default it writes presence only for chats already in
`public.chats` (active, not excluded from QA); set `SYNC_ALL_CHATS=1` to cover
every group the account is in.

Only active employees are matched, so a former employee still sitting in a chat
does not "fill" a role. Run it **before** the daily summary so the dashboard and
the Telegram message reflect the fresh membership.

## Deploying on Render

`render.yaml` defines three services:

- **`ob-chat-checklist-dashboard`** — a Node web service (`npm start`).
- **`ob-chat-checklist-telegram-sync`** — a cron job (`npm run telegram-sync`),
  scheduled at `30 3 * * *` (07:30 Asia/Yerevan) so presence is refreshed
  **before** the summary.
- **`ob-chat-checklist-daily`** — a cron job (`npm run daily-report`), scheduled
  at `0 4 * * *` (08:00 Asia/Yerevan). Adjust the schedule as needed.

Set the secret env vars (`SUPABASE_SERVICE_ROLE_KEY`, `ACCESS_PASSWORD`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PLATFORM_URL`, and for the sync
`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`) in the Render
dashboard — they are marked `sync: false` and are not stored in the repo.

The cron `schedule: "0 4 * * *"` is 04:00 UTC = **08:00 Asia/Yerevan**. Change
the cron string in `render.yaml` to move the send time.

## Security notes

- The Supabase **service role key never reaches the browser** — the dashboard
  reads Supabase only server-side and exposes a read-only API.
- `/api/problem-chats` and `/login` are rate-limited (see *Access control*).
- The `v_chat_missing_responsibles` view is `security_invoker` and not granted to
  `anon`/`authenticated`, so it cannot leak the underlying RLS-protected data
  through the public API.
- **Heads-up (pre-existing, not changed by this project):** the OB FAQ Supabase
  project has **15 tables with Row Level Security disabled** — fully exposed to
  the anon/authenticated roles. They are unrelated to this dashboard and were
  left untouched:
  `interview_calls`, `reconcile_runs`, `intv_candidates`, `intv_interviews`,
  `intv_transcripts`, `intv_transcript_segments`, `intv_analyses`, `intv_scores`,
  `intv_sync_logs`, `intv_notify_state`, `sqa_accountant_workload`,
  `sqa_daily_plan`, `mqa_evaluations_dedup_backup`, `kk_accountant_aliases`,
  `kk_problem_ratings`. Enabling RLS **without** policies would block all access,
  so this is surfaced for a human to decide — it is **not** auto-fixed here.

## Mandatory "answer yesterday's tickets first" gate

Every ordinary accountant must review **all of their tickets from yesterday**
before they can use the rest of the platform. A ticket is a `public.kk_problems`
row from the manual quality review (`source ∈ {margarita_review, sona_review}`;
AI detections are **not** tickets here). For each yesterday ticket the accountant
must pick exactly one action:

- **Принять** — confirm the ticket is valid → writes `kk_problem_acknowledgements`.
- **Подать апелляцию** — dispute it with a **mandatory comment** →
  writes `kk_problem_appeals` (`status='pending'`).

### How it works

- **Accountant identity.** The shared `ACCESS_PASSWORD` locks the dashboard but
  does not say *who* logged in. The login now also asks for a **personal login
  code**, resolved **server-side** via the existing shared `resolve_login_code`
  RPC (`login_codes` table, same Supabase project as the accountants dashboard).
  The resolved identity `{employee_id, full_name, role, can_see_all}` is stored
  in an **HMAC-signed, HttpOnly** session cookie — the browser cannot forge or
  change it. No accountant id/name/role is ever trusted from form data.
- **Server-side gate** (`server.js` → `ticketGate`). After login the server
  computes the accountant's unresolved yesterday tickets. If any remain, every
  dashboard page redirects to `/review-tickets` and every protected API returns
  **423**. Opening a dashboard URL or calling an API directly cannot bypass it.
  The login, logout, health check and the review page + its APIs stay reachable
  (no redirect loop). Supervisors (`head_accountant, ceo, founder, qa, admin` or
  `can_see_all`) are the only explicit bypass.
- **"Yesterday" = the full previous calendar day in `Asia/Yerevan`** (not the
  last 24h). One shared helper, `yesterdayRange()` in `lib/ticketReview.js`,
  returns an inclusive-start / exclusive-end UTC range and is reused by the gate,
  review page, API, tests and the Telegram report. It uses `Intl` timezone math,
  so it is correct regardless of the server's UTC clock. **A ticket's business
  date is the `Asia/Yerevan` calendar day of its `detected_at`.**
- **Not blocked by:** today's tickets, older tickets, another accountant's
  tickets, reviewer-confirmed false positives (`verdict='not_problematic'`),
  test chats, or tickets already accepted/appealed.
- **Durable + race-safe.** Writes go through the `SECURITY DEFINER` RPC
  `kk_ticket_answer` (one transaction; locks the ticket row `FOR SHARE`), which
  guarantees a ticket can never be **both** accepted and appealed and rejects
  duplicates. `EXECUTE` is granted to `service_role` only. Answering the last
  ticket recomputes the count server-side and unlocks the platform immediately.
- **Read-only on business data.** The gate only **reads** `kk_problems`; it never
  modifies `chats`, `messages`, `chat_employee_presence`, `mqa_chats` or the
  original `kk_problems` rows. Reactions are written only to the workflow tables
  `kk_problem_acknowledgements` / `kk_problem_appeals` (RLS already enabled).

### Daily Telegram ticket report

`scripts/daily-report.js` now also sends a compact per-accountant Russian report
for yesterday to `TELEGRAM_CHAT_ID` (`📋 Отчёт по тикетам за ДД.ММ.ГГГГ`), with
`Апелляций` / `Принято` / `Без ответа` and 🔴/🟠/🟢 severity lists. The counts
come from the **same** shared logic as the gate (`lib/ticketReview.js`), so they
never drift from the platform. Content is HTML-escaped, long reports are split
safely on line boundaries (never mid-ticket), and idempotency keys off the
Asia/Yerevan report date so it is not sent twice for the same day. The existing
"missing responsibles" summary is still sent, unchanged.

## Migrations

One **additive, read-only** migration: it creates the
`public.v_chat_missing_responsibles` view over the existing `chats`,
`chat_employee_presence` and `messages` tables (see `sql/`). No existing table,
data or logic is modified. The view is `security_invoker = true` and its access
is revoked from `anon`/`authenticated`.

A second **additive** migration, `sql/003_ticket_review_gate.sql`, adds the
`public.kk_ticket_answer(...)` RPC used by the ticket gate. It creates **no new
tables** and modifies no business data — it only inserts into the existing
`kk_problem_acknowledgements` / `kk_problem_appeals` workflow tables inside one
transaction, and `EXECUTE` is restricted to `service_role`.
