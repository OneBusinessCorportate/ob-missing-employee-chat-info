# ob-missing-employee-chat-info

A tiny **system checklist** platform for client Telegram chats that are missing
a responsible person (Accountant / Head Accountant / Manager).

This is **not** an employee-violation report — it is a technical checklist, like
the old Google Sheet, so the whole team can see all mismatches in one place.

It has two parts:

1. **Dashboard** (`server.js` + `public/`) — a clean, mobile-friendly web page
   listing every problematic chat, what it is missing, and a link to the chat.
2. **Daily Telegram summary** (`scripts/daily-report.js`) — posts only a short
   summary + a link to the dashboard. It never posts the full list anymore.

Both share `lib/problemChats.js`, so the counts in Telegram always match the
dashboard.

## What counts as a "problem"

A chat is problematic when it is missing **at least one** of these roles:

| Role            | Source (jsonb)                    |
| --------------- | --------------------------------- |
| Accountant      | `participants.accountant`         |
| Head Accountant | `participants.head_accountant`    |
| Manager         | `participants.manager`            |

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
| `TELEGRAM_BOT_TOKEN`        | report             | Bot that posts the daily summary.                           |
| `TELEGRAM_CHAT_ID`          | report             | Chat/group the summary is posted to.                        |
| `PLATFORM_URL`              | report             | Public dashboard URL — the link inside the Telegram message.|
| `PORT`                      | dashboard          | Render sets this automatically.                             |
| `DRY_RUN`                   | report             | `1` to print instead of send.                              |

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

## Migrations

None required. The existing `client_telegram_chats` table (including `chat_link`)
already supports everything this project needs, and no existing data or logic is
modified.
