# ob-missing-employee-chat-info

A tiny **system checklist** platform for client Telegram chats that are missing
a responsible person (Accountant / Head Accountant / Manager).

This is **not** an employee-violation report — it is a technical checklist, like
the old Google Sheet, so the whole team can see all mismatches in one place.

It has two parts:

1. **Dashboard** (`server.js` + `public/`) — a clean, mobile-friendly web page
   listing every problematic chat, what it is missing, and a link to the chat.
   Protected by a shared-password login, with role filters, name/client/contract
   search, sorting, CSV export, copy-link, manual refresh and a "last updated"
   timestamp.
2. **Daily Telegram summary** (`scripts/daily-report.js`) — posts only a short
   summary + a link to the dashboard. It never posts the full list anymore.
   Sends with retry/backoff, structured JSON logs and optional idempotency.

Both share `lib/problemChats.js`, so the counts in Telegram always match the
dashboard. Auth + rate limiting live in `lib/auth.js`.

## Tests

```bash
npm test        # node:test — covers computeProblems, auth, the daily message
```

Coverage includes: all roles present, each role missing, multiple missing,
absent `participants`, the pluralised-column fallback
(`accountants`/`head_accountants`/`managers`), duplicate-name detection, the
counts, and a regression lock on the known baseline (14 chats → 7 problems →
3 / 5 / 3). CI runs the same suite on every push/PR
(`.github/workflows/ci.yml`).

## What counts as a "problem"

A chat is problematic when it is missing **at least one** of these roles:

| Role            | Source (jsonb)                    |
| --------------- | --------------------------------- |
| Accountant      | `participants.accountant`         |
| Head Accountant | `participants.head_accountant`    |
| Manager         | `participants.manager`            |

### Test chats are excluded

QA/test chats (currently every row in the table is one — named `testchat…`,
created by "Lina") are **filtered out** so the checklist only shows real client
chats. By default any chat whose name starts with `test` (case-insensitive) is
excluded from the list **and** the counts; the number hidden is shown as
"тестовых скрыто". Real chats appear automatically as soon as they are added.

- `EXCLUDE_TEST_CHATS=0` — turn the filter off (show everything).
- `TEST_CHAT_PATTERN` — override the regex (e.g. `^(test|qa)-`).

Because the table currently contains **only** test chats, the live dashboard
shows 0 real chats until real ones are added.

"Missing" simply means the role's array is empty or absent. The dashboard and
summary report:

- total number of problematic chats,
- how many are missing an Accountant,
- how many are missing a Head Accountant,
- how many are missing a Manager.

(A chat missing two roles is counted once in the total and once under each role
it is missing, so the per-role numbers can add up to more than the total.)

Data lives in the Supabase table **`public.client_telegram_chats`** in the
**OB FAQ** project (`fjsogozwseqoxgddjeig`). No schema change is required — the
`chat_link` column already exists for the Telegram chat links.

## Running locally

```bash
npm install
cp .env.example .env      # fill in the values
npm start                 # dashboard on http://localhost:3000
npm run daily-report      # send the daily summary (use DRY_RUN=1 to preview)
```

`DRY_RUN=1 npm run daily-report` prints the message instead of sending it.

## Environment variables

| Variable                    | Used by            | Notes                                                        |
| --------------------------- | ------------------ | ----------------------------------------------------------- |
| `SUPABASE_URL`              | dashboard + report | Defaults to the OB FAQ URL.                                 |
| `SUPABASE_SERVICE_ROLE_KEY` | dashboard + report | **Required.** Service role key (kept server-side only).      |
| `ACCESS_PASSWORD`           | dashboard          | Shared login password. If unset, the dashboard is **open** (dev only) — set it in production. |
| `SESSION_SECRET`            | dashboard          | Optional. HMAC secret for the session cookie; derived from `ACCESS_PASSWORD` if unset. |
| `NODE_ENV`                  | dashboard          | Set to `production` on Render so the session cookie is `Secure`. |
| `TELEGRAM_BOT_TOKEN`        | report             | Bot that posts the daily summary.                           |
| `TELEGRAM_CHAT_ID`          | report             | Chat/group the summary is posted to.                        |
| `PLATFORM_URL`              | report             | Public dashboard URL — the link inside the Telegram message.|
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

`client_telegram_chats` has Row Level Security enabled and only allows
authenticated, non-restricted users. The dashboard therefore reads it
**server-side with the service role key** and exposes a read-only
`/api/problem-chats` endpoint; the browser never sees the key or talks to
Supabase directly.

## Where the platform link is configured

The link that goes into the Telegram message is the **`PLATFORM_URL`** env var
on the daily-report cron job. After the dashboard is deployed, set `PLATFORM_URL`
to its public URL (e.g. `https://ob-chat-checklist-dashboard.onrender.com`).

## How to add / update Telegram chat links

The link shown on the dashboard ("Открыть чат") and the chat data come from the
`client_telegram_chats` table. To set or change a chat link, update the
`chat_link` column for that row, e.g. in the Supabase SQL editor:

```sql
update public.client_telegram_chats
set chat_link = 'https://t.me/+XXXXXXXX'
where id = '<chat-uuid>';        -- or: where chat_name = '...'
```

Chats without a `chat_link` still appear in the list; their button just shows
"Нет ссылки" until a link is added.

## Deploying on Render

`render.yaml` defines two services:

- **`ob-chat-checklist-dashboard`** — a Node web service (`npm start`).
- **`ob-chat-checklist-daily`** — a cron job (`npm run daily-report`), scheduled
  at `0 4 * * *` (08:00 Asia/Yerevan). Adjust the schedule as needed.

Set the secret env vars (`SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `PLATFORM_URL`) in the Render dashboard — they are marked
`sync: false` and are not stored in the repo.

The cron `schedule: "0 4 * * *"` is 04:00 UTC = **08:00 Asia/Yerevan**. Change
the cron string in `render.yaml` to move the send time.

## Security notes

- The Supabase **service role key never reaches the browser** — the dashboard
  reads Supabase only server-side and exposes a read-only API.
- `/api/problem-chats` and `/login` are rate-limited (see *Access control*).
- **Heads-up (not changed by this project):** the OB FAQ Supabase project has
  **15 tables with Row Level Security disabled** — these are fully exposed to the
  anon/authenticated roles. They are unrelated to this dashboard and were left
  untouched:
  `interview_calls`, `reconcile_runs`, `intv_candidates`, `intv_interviews`,
  `intv_transcripts`, `intv_transcript_segments`, `intv_analyses`, `intv_scores`,
  `intv_sync_logs`, `intv_notify_state`, `sqa_accountant_workload`,
  `sqa_daily_plan`, `mqa_evaluations_dedup_backup`, `kk_accountant_aliases`,
  `kk_problem_ratings`.
  Enabling RLS **without** policies would block all access to them, so this is
  surfaced for a human to decide — it is **not** auto-fixed here.
  `client_telegram_chats` itself already has RLS enabled (authenticated only),
  which is why we read it with the service role key.

## Migrations

None required. The existing `client_telegram_chats` table (including `chat_link`)
already supports everything this project needs, and no existing data or logic is
modified. Duplicate `chat_name` values (e.g. several `testchat1`) are
disambiguated in the UI by client name, contract number and `telegram_chat_id`
rather than by any schema change.
