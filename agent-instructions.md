# Agent instructions

You are setting up **Accom Checker** for a new operator (a student or their friend).

## Fork first — do not set up on the original repo

1. **Fork** this repository into the user’s own GitHub account (or an org they control).
2. Clone **the fork**, not the upstream template URL.
3. Do all work, secrets, Actions, Vercel, and cron-job.org jobs against **the fork only**.
4. Never push secrets, cookies, or a filled-in `.env` back to the upstream template.

The upstream repo is a blank template. Setting up on it would mix a new person’s login and mailbox with someone else’s GitHub account. If the user already cloned the original, stop and fork, then start over in the fork.

---

The rest of this file assumes you are already on the fork.

---

## How to think about this project

- **The checker is the product.** `src/check.js` (Selenium + Chrome on GitHub Actions) is the only path that can see rooms and send an availability alert. Everything else exists to start that job, keep a login session alive, or show status.
- **The dashboard is not on the critical path.** cron-job.org should POST `workflow_dispatch` **directly to the GitHub API**. Vercel is for viewing status and submitting MFA / email codes. If Vercel is down, checks must still run.
- **Do not use GitHub `on.schedule`.** It was removed on purpose (unreliable). Scheduling stays on cron-job.org (or any external cron that can POST to GitHub).
- **The `status` branch is a data store**, not code. Every check rewrites `status.json`, `events.json`, and `control.json` there. Disable Vercel deploys for it (`dashboard/vercel.json` already does). If you inherited this repo, replace that branch with a fresh empty one so you do not keep the previous operator’s run history.
- **Identity lives only in secrets.** Never hardcode a from-address, destination list, LSE credentials, `owner/repo`, Vercel URL, or cron-job.org job ID.
- **Mail is generic SMTP.** There is no built-in Gmail (or any other) account. You collect the operator’s own provider settings. Do not assume Gmail.
- **PII must not land on the status branch.** Writes go through `redactPii` / `sanitizeDeep` in `src/status.js`. Do not bypass that. Do not commit `.env`, `.auth/`, or `.state/`.
- **Private GitHub repos burn Actions minutes.** A 5-minute cadence with ~2-minute runs can exhaust a private-repo allowance in days. Prefer a public repo (secrets stay in GitHub Secrets), a slower cadence, or a paid minutes budget. `/api/watchdog` only *detects* silent failure; it does not add minutes.

### What you must never do

- Commit secrets, cookies, PATs, SMTP passwords, or a filled-in `.env`.
- Re-add hardcoded extra recipients, a default `owner/repo`, or a default cron-job.org job ID.
- Re-add GitHub-native `schedule:` triggers.
- Reuse a previous operator’s SMTP user, from-address, destination addresses, LSE login, or cron job IDs.
- Force-push or wipe the `status` branch without an explicit user request (except: on a handed-over repo, ask once, then replace it with a clean branch).

---

## What you must collect from this user

Do not invent values. Do not copy anything from git history, old issues, or another person’s setup.

| Need | Why | Where it is stored |
|------|-----|--------------------|
| GitHub repo they own (`owner/repo`) and default branch name | Status writes, workflow dispatch, dashboard | `GITHUB_STATUS_REPO`, `GITHUB_REPOSITORY`, `GITHUB_REPO` |
| LSE portal email + password | Re-login when cookies expire | `LSE_EMAIL`, `LSE_PASSWORD` (GitHub Secrets) |
| SMTP host, port, TLS flag, username, password | Send mail from **their** account | `SMTP_*` (GitHub Secrets) |
| From address that mailbox is allowed to send as | Envelope sender | `EMAIL_FROM` (optional; falls back to `SMTP_USER`) |
| Destination address(es) | Who gets alerts + the daily summary | `EMAIL_TO` (comma-separated is fine) |
| Optional extra availability-only recipients | Extra people on room alerts, not the daily summary | `EXTRA_AVAILABILITY_EMAIL_TO` |
| Dashboard login password | Protects the Vercel UI | `DASHBOARD_PASSWORD` (Vercel) |
| GitHub PAT (read) | Dashboard reads the status branch | `GITHUB_STATUS_TOKEN` (Vercel) |
| GitHub PAT (write + `actions:write`) | Dashboard writes control and dispatches workflows; cron-job.org dispatches workflows | `GITHUB_STATUS_WRITE_TOKEN` (Vercel), `GITHUB_DISPATCH_TOKEN` (setup script / cron-job.org headers) |
| cron-job.org account + API key | Create and pause **their** schedule | `CRONJOB_API_KEY` |
| Checker job ID **after** you create jobs | Dashboard pause / frequency | `CRONJOB_CHECKER_JOB_ID` — **their** new job, never a number from this repo’s history |
| Shared cron token | Optional watchdog / `/api/cron` | `CRON_SECRET` |
| Timezone and summary time | When the daily note fires | `TIMEZONE`, `SUMMARY_HOUR`, `SUMMARY_MINUTE` (defaults: Europe/London, 23:55) |

If they do not have SMTP yet, help them create **their own** provider account (workspace mail, transactional email, or a personal mailbox with an app password). Never point the app at a previous operator’s mailbox.

---

## Architecture

```
cron-job.org ──(every N min)──> POST GitHub API workflow_dispatch
                                   .../check-availability.yml/dispatches
                                        └─> Actions: Selenium logs into LSE,
                                            scrapes availability, emails on
                                            change, writes the `status` branch

cron-job.org ──(daily)────────> POST .../daily-summary.yml/dispatches
                                        └─> Actions: reads status + run
                                            history, emails the summary

Vercel dashboard ── reads/writes `status` branch; pause/resume PATCHes
                    the cron-job.org checker job. Optional /api/cron,
                    /api/summary, /api/watchdog exist but are not required
                    for the checker to run.
```

| Path | Role |
|------|------|
| `src/check.js` | Login, MFA wait, scrape, availability email |
| `src/login.js` | Interactive local login to seed `.auth/lse-cookies.json` |
| `src/summary.js` | Daily summary email |
| `src/status.js` | Read/write status files (local `.state/` and the `status` branch) |
| `dashboard/` | Next.js UI + API routes |
| `scripts/setup-cronjobs.mjs` | Create/update the two cron-job.org dispatch jobs |
| `.github/workflows/check-availability.yml` | Checker (dispatch only) |
| `.github/workflows/daily-summary.yml` | Summary (dispatch only) |
| `.github/workflows/test-emails.yml` | Manual test send (dispatch only) |

---

## Setup

Work only in **the user’s fork**, plus **their** mail account, cron-job.org account, and Vercel project.

### 1. Repository (the fork)

1. Confirm `git remote -v` points at the user’s fork, not the upstream template.
2. Keep `.env`, `.auth/`, and `.state/` gitignored.
3. Create an empty `status` branch on the fork, or let the dashboard create it on first write from `GITHUB_STATUS_DEFAULT_BRANCH`. Do not copy another operator’s `status` branch.

### 2. Local toolchain

```bash
cp .env.example .env
# fill only this user's values — never commit .env
npm ci
cd dashboard && npm ci && cd ..
npm test
```

Chrome + ChromeDriver must be available for `npm run check` and `npm run login`.

### 3. Seed an LSE session

```bash
npm run login
```

Complete Microsoft / LSE login in the browser, then press Enter. Cookies go to `.auth/lse-cookies.json`. For Actions:

```bash
base64 -w0 .auth/lse-cookies.json
```

Store the output as `LSE_COOKIES_B64`. Refresh it when sessions expire (`needs_mfa` / `needs_email_code` / `login_failed`).

### 4. GitHub Actions secrets

| Secret | Notes |
|--------|--------|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | This user’s mail provider. `SMTP_SECURE` is the string `true` or `false`. |
| `EMAIL_FROM` | Address they are allowed to send as. If omitted, code falls back to `SMTP_USER`. |
| `EMAIL_TO` | Who receives the daily summary and (by default) availability alerts. |
| `EXTRA_AVAILABILITY_EMAIL_TO` | Optional. Extra availability-alert recipients only. |
| `LSE_EMAIL`, `LSE_PASSWORD` | Portal login used when cookies expire. |
| `LSE_COOKIES_B64` | Seed session from step 3. |

`GITHUB_TOKEN` is provided by Actions. Workflows already map the secrets above into env vars.

### 5. External schedule (cron-job.org)

Create a [cron-job.org](https://console.cron-job.org) account. Create a GitHub PAT with `actions:write` on **this** repo. Then:

```bash
export CRONJOB_API_KEY=...          # cron-job.org → Settings → API
export GITHUB_DISPATCH_TOKEN=...    # GitHub PAT
export GITHUB_REPO=you/your-repo    # required; no default
# optional: GITHUB_REF, TIMEZONE, CHECK_INTERVAL_MINUTES, SUMMARY_HOUR, SUMMARY_MINUTE

node scripts/setup-cronjobs.mjs
```

The script upserts two jobs by title/URL:

- **Accom checker GitHub Actions dispatch** — POST `check-availability.yml/dispatches`, every `CHECK_INTERVAL_MINUTES` (default 5), timezone default `Europe/London`.
- **Accom daily summary GitHub Actions dispatch** — POST `daily-summary.yml/dispatches`, default 23:55 in that timezone.

Copy the **checker** job’s numeric ID. That is `CRONJOB_CHECKER_JOB_ID`.

Optional health watchdog: a third job can GET `https://<their-vercel-host>/api/watchdog` every 15 minutes with `Authorization: Bearer <CRON_SECRET>` and cron-job.org failure emails enabled (`onFailureCount: 2`). That alert is sent by cron-job.org, not by this app’s SMTP.

### 6. Dashboard (Vercel)

1. Import **this user’s** clone. Set the Root Directory to `dashboard`.
2. Set Production environment variables:

| Variable | Notes |
|----------|--------|
| `GITHUB_STATUS_REPO` | `owner/repo` of this project. Required. |
| `GITHUB_STATUS_BRANCH` | `status` |
| `GITHUB_STATUS_DEFAULT_BRANCH` | Usually `master` or `main` |
| `GITHUB_STATUS_TOKEN` | Read PAT |
| `GITHUB_STATUS_WRITE_TOKEN` | Write + dispatch PAT |
| `DASHBOARD_PASSWORD` | UI password |
| `CRONJOB_API_KEY` | Pause/resume and frequency |
| `CRONJOB_CHECKER_JOB_ID` | **Their** checker job ID from step 5 |
| `CRON_SECRET` | If you use `/api/cron`, `/api/summary`, or `/api/watchdog` |

3. Confirm `status`-branch deploys stay disabled (`dashboard/vercel.json`).
4. Test Start / Stop on the dashboard (that enables/disables **their** cron-job.org checker job).

### 7. Smoke test

- GitHub → Actions → **Send test emails** (`test-emails.yml`) → Run workflow. Mail must arrive at **this user’s** `EMAIL_TO`.
- Or locally: `npm run summary` and `SEND_TEST_AVAILABILITY_EMAIL=true npm run test:availability-inject`.
- Wait for one checker dispatch. Approve Authenticator / paste an email code on the dashboard if a run is waiting (`MFA_WAIT_MS` defaults to 4 minutes).

---

## Local commands

| Command | Purpose |
|---------|---------|
| `npm run check` | One availability check |
| `npm run login` | Seed cookies |
| `npm run summary` | Send today’s summary now |
| `npm test` | Unit tests (no SMTP, no LSE) |
| `npm run test:availability-inject` | Detector + optional test email |
| `cd dashboard && npm run dev` | Dashboard on localhost |

---

## Operational notes

- **Concurrency:** `check-availability.yml` uses a single concurrency group and does not cancel in-progress runs (MFA waits need the browser). Extra dispatches while a run is active can be dropped.
- **Do not restore Chrome profiles across runners.** Only cookies are cached.
- **Rotate** SMTP passwords, GitHub PATs, and the cron-job.org API key if they were ever pasted into chat. Re-run `scripts/setup-cronjobs.mjs` after rotating the dispatch PAT.
- See `.env.example` for the full variable list. Runtime code reads only environment variables.

---

## Handover checklist (outgoing operator)

Friends should **fork**, not take over this GitHub account. Still, before you share the link:

1. Delete every GitHub Actions secret on this repo (`SMTP_*`, `EMAIL_*`, `LSE_*`, and anything else). An agent in this environment cannot delete them (API 403).
2. Disable or delete your cron-job.org jobs (they still hold a GitHub PAT in request headers).
3. Remove or recreate the Vercel project; delete its env vars.
4. Rotate the GitHub PAT that cron-job.org and Vercel used.
5. The `status` branch on this template should stay an empty store (no run history). Do not leave your booking state on a public branch.
