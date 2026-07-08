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
- **`public.chat_employee_presence`** — who is present in each chat, with
  `employee_role` (`accountant` / `head_accountant` / `manager` / …) and
  `is_present`.

A read-only view **`public.v_chat_missing_responsibles`** aggregates these into
one row per checked chat with `has_accountant` / `has_head_accountant` /
`has_manager` / `checked_at`. The app selects from that view (server-side, with
the service role key). See [Migrations](#migrations).

> The older `public.client_telegram_chats` table (participants jsonb) held only
> QA/test rows and is **not** used anymore.

## What counts as a "problem"

A chat is problematic when it is missing **at least one** of these roles:

| Role            | "Missing" means…                                          |
| --------------- | --------------------------------------------------------- |
| Accountant      | no present employee with role `accountant`                |
| Head Accountant | no present employee with role `head_accountant`           |
| Manager         | no present employee with role `manager`                   |

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
| `EXCLUDE_TEST_CHATS`        | dashboard + report | `0` to show test chats too. Default: exclude them.          |
| `TEST_CHAT_PATTERN`         | dashboard + report | Optional regex for what counts as a test chat (default `^test`). |
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

## Deploying on Render

`render.yaml` defines two services:

- **`ob-chat-checklist-dashboard`** — a Node web service (`npm start`).
- **`ob-chat-checklist-daily`** — a cron job (`npm run daily-report`), scheduled
  at `0 4 * * *` (08:00 Asia/Yerevan). Adjust the schedule as needed.

Set the secret env vars (`SUPABASE_SERVICE_ROLE_KEY`, `ACCESS_PASSWORD`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PLATFORM_URL`) in the Render
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

## Migrations

One **additive, read-only** migration: it creates the
`public.v_chat_missing_responsibles` view over the existing `chats` and
`chat_employee_presence` tables (see `sql/`). No existing table, data or logic is
modified. The view is `security_invoker = true` and its access is revoked from
`anon`/`authenticated`.
