# Accom Checker

Logs into the LSE student accommodation portal, looks for rooms, and emails **your** addresses when availability appears. A daily summary email reports how the checker ran. An optional Next.js dashboard (typically on Vercel) shows live status, pause/resume, check frequency, and MFA / email-code entry.

This repository is a **template for a new operator**. It must not contain anyone else's SMTP account, LSE login, GitHub repo, Vercel project, or cron-job.org job IDs. All of that is supplied at setup time through environment variables and hosted secrets.

## How an agent should think about this project

Read this section before changing code or walking a user through setup.

### Mental model

- **The checker is the product.** `src/check.js` (Selenium + Chrome) is the only path that can see rooms and send an availability email. GitHub Actions runs it. Everything else exists to start that job, keep a login session alive, or tell the operator what happened.
- **The dashboard is not on the critical path.** cron-job.org should POST `workflow_dispatch` **directly to the GitHub API**. Vercel is for viewing status and submitting MFA / email codes. If Vercel is down, checks must still run.
- **Do not use GitHub `on.schedule`.** It was removed on purpose (unreliable). Scheduling stays on cron-job.org (or any external cron that can POST to GitHub).
- **The `status` branch is a data store**, not code. Every check rewrites `status.json`, `events.json`, and `control.json` there. Do not treat it like a feature branch. Disable Vercel deploys for it (`dashboard/vercel.json` already does).
- **Identity lives only in secrets.** Never hardcode `EMAIL_FROM`, `EMAIL_TO`, extra recipients, LSE credentials, a GitHub `owner/repo`, a Vercel URL, or a cron-job.org job ID. If a value belongs to one person, it belongs in env / GitHub Secrets / Vercel env — not in source.
- **Email is generic SMTP.** There is no built-in Gmail (or any other) from-address. The operator chooses the provider and sets `SMTP_*`, `EMAIL_FROM`, and `EMAIL_TO`.
- **PII must not land on the status branch.** Writes go through `redactPii` / `sanitizeDeep` in `src/status.js`. Do not bypass that. Do not commit `.env`, `.auth/`, or `.state/`.
- **Private GitHub repos burn Actions minutes.** A 5-minute cadence with ~2-minute runs can exhaust a private-repo allowance in days. Prefer a public repo (secrets stay in GitHub Secrets), a slower cadence, or a paid minutes budget. The Vercel `/api/watchdog` route only *detects* silent failure; it does not add minutes.

### What you must collect from the user before setup

Do not invent or reuse another operator's values. Ask for, or help the user create, all of the following:

| Need | Why | Where it is stored |
|------|-----|--------------------|
| GitHub repo they own (`owner/repo`) and default branch name | Status writes, workflow dispatch, dashboard | `GITHUB_STATUS_REPO`, `GITHUB_REPOSITORY`, `GITHUB_REPO` |
| LSE portal email + password | Re-login when cookies expire | `LSE_EMAIL`, `LSE_PASSWORD` (GitHub Secrets) |
| SMTP host, port, TLS flag, username, password | Send mail | `SMTP_*` (GitHub Secrets) |
| From address the SMTP account is allowed to send as | Envelope sender | `EMAIL_FROM` (optional; falls back to `SMTP_USER`) |
| One or more destination addresses | Alerts + daily summary | `EMAIL_TO`; optional `EXTRA_AVAILABILITY_EMAIL_TO` for extra **availability** recipients only |
| Dashboard login password | Protects the Vercel UI | `DASHBOARD_PASSWORD` (Vercel) |
| GitHub PAT (read) | Dashboard reads the status branch | `GITHUB_STATUS_TOKEN` (Vercel) |
| GitHub PAT (write + `actions:write`) | Dashboard writes control, dispatches workflows; cron-job.org dispatches workflows | `GITHUB_STATUS_WRITE_TOKEN` (Vercel), `GITHUB_DISPATCH_TOKEN` (local setup script / cron-job.org headers) |
| cron-job.org account + API key | Create and pause the schedule | `CRONJOB_API_KEY` |
| Checker job ID **after** jobs are created | Dashboard pause / frequency | `CRONJOB_CHECKER_JOB_ID` (Vercel) — **their** job, never a number from this repo's history |
| Shared cron token | Optional watchdog / alternate `/api/cron` path | `CRON_SECRET` (Vercel + cron-job.org) |
| Timezone and summary time | When the daily email fires | `TIMEZONE`, `SUMMARY_HOUR`, `SUMMARY_MINUTE` (defaults: Europe/London, 23:55) |

If the user does not have SMTP yet, help them create **their own** provider account (transactional email, workspace mail, or a personal mailbox with an app password). Do not point the app at a previous operator's mailbox.

### What an agent must never do

- Commit secrets, cookies, PATs, SMTP passwords, or a filled-in `.env`.
- Re-add hardcoded extra recipients, a default `owner/repo`, or a default cron-job.org job ID.
- Re-add GitHub-native `schedule:` triggers.
- Force-push or wipe the `status` branch without an explicit user request (that history can contain scraped PII on older clones).
- Assume Gmail. SMTP is whatever the user configured.

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

## New-operator setup

Work in **your** GitHub repo, **your** SMTP account, **your** cron-job.org account, and **your** Vercel project.

### 1. Repository

1. Fork or copy this repo into an account you control.
2. Create an empty `status` branch (or let the dashboard create it on first write from `GITHUB_STATUS_DEFAULT_BRANCH`).
3. Keep `.env`, `.auth/`, and `.state/` gitignored.

### 2. Local toolchain

```bash
cp .env.example .env
# fill in SMTP, LSE_*, and (for the dashboard) GitHub / cron-job.org values
npm ci
cd dashboard && npm ci && cd ..
npm test
```

Chrome + ChromeDriver must be available for `npm run check` and `npm run login`.

### 3. Seed an LSE session

```bash
npm run login
```

Complete Microsoft / LSE login in the browser, then press Enter. Cookies are written to `.auth/lse-cookies.json`. For Actions:

```bash
base64 -w0 .auth/lse-cookies.json
```

Store the output as the `LSE_COOKIES_B64` GitHub secret. Refresh it when sessions expire (`needs_mfa` / `needs_email_code` / `login_failed` in the daily summary).

### 4. GitHub Actions secrets

Repository → Settings → Secrets and variables → Actions:

| Secret | Notes |
|--------|--------|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | Your mail provider. `SMTP_SECURE` is the string `true` or `false`. |
| `EMAIL_FROM` | Address you are allowed to send as. If omitted, the workflow still runs; code falls back to `SMTP_USER`. |
| `EMAIL_TO` | Who receives the daily summary and (by default) availability alerts. Comma-separated is fine. |
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

The script upserts two jobs by title/URL (it will not touch another account's jobs unless you pointed it at that account's API key):

- **Accom checker GitHub Actions dispatch** — POST `check-availability.yml/dispatches`, every `CHECK_INTERVAL_MINUTES` (default 5), timezone default `Europe/London`.
- **Accom daily summary GitHub Actions dispatch** — POST `daily-summary.yml/dispatches`, default 23:55 in that timezone.

Copy the **checker** job's numeric ID from the cron-job.org console. That value is `CRONJOB_CHECKER_JOB_ID`. Put the same PAT in each job's request headers if you create jobs by hand instead of using the script.

Optional health watchdog: a third cron-job.org job can GET `https://<your-vercel-host>/api/watchdog` every 15 minutes with `Authorization: Bearer <CRON_SECRET>` and cron-job.org's own failure emails enabled (`onFailureCount: 2` is a reasonable flake filter). That email is sent by cron-job.org, not by this app's SMTP.

### 6. Dashboard (Vercel)

1. Import **your** clone. Set the Root Directory to `dashboard`.
2. Set Vercel environment variables (Production):

| Variable | Notes |
|----------|--------|
| `GITHUB_STATUS_REPO` | `owner/repo` of this project. Required. |
| `GITHUB_STATUS_BRANCH` | `status` |
| `GITHUB_STATUS_DEFAULT_BRANCH` | Usually `master` or `main` |
| `GITHUB_STATUS_TOKEN` | Read PAT |
| `GITHUB_STATUS_WRITE_TOKEN` | Write + dispatch PAT |
| `DASHBOARD_PASSWORD` | UI password |
| `CRONJOB_API_KEY` | Pause/resume and frequency |
| `CRONJOB_CHECKER_JOB_ID` | **Your** checker job ID from step 5 |
| `CRON_SECRET` | If you use `/api/cron`, `/api/summary`, or `/api/watchdog` |

3. Confirm `status`-branch deploys stay disabled (`dashboard/vercel.json`).
4. After deploy, open the Vercel URL, log in, and test Start / Stop (that enables/disables **your** cron-job.org checker job).

### 7. Smoke test

- GitHub → Actions → **Send test emails** (`test-emails.yml`) → Run workflow. Confirm mail arrives at **your** `EMAIL_TO`.
- Or locally, with `.env` filled in: `npm run summary` and `SEND_TEST_AVAILABILITY_EMAIL=true npm run test:availability-inject`.
- Wait for one checker dispatch. The dashboard should show a fresh status. Approve Authenticator / paste an email code there if a run is waiting (`MFA_WAIT_MS` defaults to 4 minutes).

## Local commands

| Command | Purpose |
|---------|---------|
| `npm run check` | One availability check |
| `npm run login` | Seed cookies |
| `npm run summary` | Send today's summary now |
| `npm test` | Unit tests (no SMTP, no LSE) |
| `npm run test:availability-inject` | Detector + optional test email |
| `cd dashboard && npm run dev` | Dashboard on localhost |

## Operational notes

- **Concurrency:** `check-availability.yml` uses a single concurrency group and does not cancel in-progress runs (MFA waits need the browser). Extra dispatches while a run is active can be dropped. If daily summaries show far fewer scrapes than the cadence implies, inspect cancelled/queued Actions runs before changing cadence.
- **Do not restore Chrome profiles across runners.** Only cookies are cached; profiles were correlated with LSE "An Error has Occurred" pages.
- **Rotate** SMTP passwords, GitHub PATs, and the cron-job.org API key if they were ever pasted into chat. Re-run `scripts/setup-cronjobs.mjs` after rotating the dispatch PAT.
- **Making the repo public:** source on `master` should stay free of secrets. Older `status` branch history on a previously operated clone may still contain scraped account-page text. Wipe or replace that branch before going public if it was used in production.

## Environment reference

See `.env.example` for the full list and comments. Runtime code reads only environment variables; it does not ship a from-address, destination list, GitHub repo, or cron job ID.
