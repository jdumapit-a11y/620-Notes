# 620 Notes — backend

This is the piece that runs unattended and sends the nightly digest even if
nobody has the board open. It also becomes the source of truth for notes,
so the board data is no longer tied to one browser.

## What it does

- Stores notes and settings in simple JSON files (`data/notes.json`,
  `data/settings.json`).
- Exposes a small API the board page talks to (`/api/notes`, `/api/settings`).
- Runs a cron job every night (11:00 PM by default) that emails everyone in
  the recipient list a digest of the day's notes via Resend, then archives
  and clears the board for the next day.
- Also exposes `POST /api/send-digest` so you can trigger a send manually to
  test it before trusting the schedule.

## 1. Get a Resend account (for sending email)

1. Sign up free at [resend.com](https://resend.com) (100 emails/day free).
2. Grab an API key from the dashboard.
3. For real use, verify your own sending domain in Resend so email doesn't
   land in spam. While testing, you can send from `onboarding@resend.dev`
   without verifying anything.

## 2. Deploy to Render (free tier)

1. Push this folder to a new GitHub repository.
2. Go to [render.com](https://render.com) → **New** → **Web Service** →
   connect that repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Under **Environment**, add the variables from `.env.example`:
   - `BOARD_KEY` — make up a passphrase, share it only with your team
   - `RESEND_API_KEY`
   - `FROM_EMAIL`
   - `DIGEST_CRON` (default `0 23 * * *` = 11 PM)
   - `TZ` (default `America/New_York`)
   - `CLEAR_AFTER_SEND` (default `true`)
5. Deploy. Render gives you a URL like `https://620-notes-backend.onrender.com`.

Render's free tier spins the service down after inactivity and wakes on the
next request — fine for the board page, but it can make the cron job late by
a few minutes if the service was asleep. Their small paid tier ($7/mo) keeps
it running exactly on schedule if that matters to you.

## 3. Point the board page at this backend

Open the board (either the Claude-hosted link or, later, your own standalone
copy) and click **"Email settings"** in the header. Enter:

- **Backend URL** — your Render URL from step 2
- **Board key** — the same passphrase you set as `BOARD_KEY`
- **Recipients** — comma-separated staff emails

Save it. The board immediately switches from local demo mode to reading and
writing notes through this backend, and everyone who opens the board shares
the same live data.

## 4. Test before trusting it

Use `POST /api/send-digest` (with header `x-board-key: <your BOARD_KEY>`) to
trigger a send immediately — for example, from a terminal:

```
curl -X POST https://your-backend.onrender.com/api/send-digest \
  -H "x-board-key: your-passphrase"
```

Confirm the email arrives, then let the nightly schedule take over.
