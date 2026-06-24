# Accom Checker — Project Status & Change Notes

_Last updated: 2026-06-16_

## What this project is

An automated checker that logs into the LSE student accommodation portal, looks
for room availability, and emails you when something opens up. It also sends a
daily summary email. A small Next.js dashboard (on Vercel) shows live status and
lets you pause/resume the checker and submit MFA/email codes.

> **New agent: start at the [TODO / Action items](#todo--action-items-for-the-next-agent)
> section at the bottom.** It lists exactly what's left to do, in priority order.

## Architecture (how it actually runs)

The **active** scheduling path is cron-job.org calling the **GitHub REST API
directly** to dispatch the workflows. The Vercel dashboard is NOT in the
checker's critical path — it's only used for viewing status and submitting
MFA/email codes. This is good: the checker keeps running even if Vercel is down
or over quota.

```
cron-job.org ──(every 5 min)──> POST GitHub API workflow_dispatch
   (jobId 7809757)                 .../check-availability.yml/dispatches
                                        │  (GitHub PAT in cron-job.org headers)
                                        └─> GitHub Actions: check-availability.yml
                                              ├─ Selenium + Chrome logs into LSE
                                              ├─ reads availability
                                              ├─ emails you if availability found
                                              └─ writes status.json / events.json
                                                 to the `status` branch (data store)

cron-job.org ──(daily 23:55 Europe/London)──> POST GitHub API workflow_dispatch
   (jobId 7833387)                              .../daily-summary.yml/dispatches
                                                    └─> GitHub Actions: daily-summary.yml
                                                          └─ reads status branch + workflow
                                                             run history, emails the summary

Vercel dashboard (status UI / pause / MFA codes) ── reads & writes status branch
   Optional alternative trigger path: /api/cron and /api/summary endpoints exist
   and dispatch the same workflows, but are NOT currently used by cron-job.org.
```

### Key components

| Path | Role |
|------|------|
| `src/check.js` | Selenium checker: login, MFA, availability scrape, email |
| `src/login.js` | Manual interactive login to seed cookies |
| `src/summary.js` | Builds and sends the daily summary email |
| `src/status.js` | Reads/writes `status.json` / `events.json` / `control.json` on the `status` branch |
| `dashboard/` | Next.js status dashboard + API routes |
| `dashboard/app/api/cron/route.js` | External-cron entry point that dispatches the checker |
| `dashboard/app/api/summary/route.js` | External-cron entry point that dispatches the summary |
| `dashboard/lib/githubStatus.js` | GitHub API helpers (read status, dispatch workflows) |
| `.github/workflows/check-availability.yml` | The actual checker run (workflow_dispatch only) |
| `.github/workflows/daily-summary.yml` | The daily summary run (workflow_dispatch only) |

### The `status` branch

`status.json`, `events.json`, and `control.json` live on a dedicated `status`
branch and are rewritten on **every** check. This branch is a data store, not
code. It is the single biggest source of operational noise (see issues below).

## Scheduling model (current decision)

- **No GitHub-native `schedule:` triggers.** GitHub's cron is unreliable and was
  firing late/irregularly. Both workflows are now `workflow_dispatch` only.
- **All scheduling is external via cron-job.org**, which POSTs directly to the
  GitHub REST API (`workflow_dispatch`) using a GitHub PAT stored in the job's
  request headers. Checker = every 5 min; summary = daily at 23:55 London.

## Changes made in this session

1. **Removed GitHub schedules** from `check-availability.yml` and
   `daily-summary.yml`. External cron is now the only trigger.
2. **Created the cron-job.org daily-summary job** (jobId 7833387) via the
   cron-job.org API. It POSTs directly to the GitHub API to dispatch
   `daily-summary.yml` at 23:55 Europe/London, reusing the same GitHub PAT as
   the existing checker job (jobId 7809757). Both jobs are live and enabled.
3. **Summary now counts both `schedule` and `workflow_dispatch` runs**
   (`src/summary.js`), de-duplicated by run id, so the count is correct
   regardless of how runs were triggered.
4. **`dashboard/vercel.json`** added to disable Vercel deploys for the `status`
   branch (see the deployment-quota issue below).
5. **`scripts/setup-cronjobs.mjs`** added to reproducibly create/update both
   cron-job.org jobs from env vars (GitHub PAT never hardcoded).

### Made but not used by the active path
- **`/api/summary` endpoint** + `dispatchSummary()` in `githubStatus.js`, and the
  lowered `MIN_CHECK_INTERVAL_MS` (4→2 min) in `/api/cron`. These only matter if
  you switch cron-job.org to call the dashboard instead of GitHub directly. They
  are harmless to keep as an alternative.

## Pause/resume now controls the cron-job.org schedule

Previously, the dashboard pause only wrote `control.json`; the checker kept being
dispatched by cron-job.org and each run just exited early. Now the dashboard
pause/resume also enables/disables the **cron-job.org checker job** (7809757) via
the cron-job.org API, so pausing actually stops the GitHub Actions runs. The
daily-summary job (7833387) is never touched and always runs.

- `setCheckerCronEnabled(enabled)` in `dashboard/lib/githubStatus.js` PATCHes the
  job's `enabled` flag.
- `dashboard/app/api/control/route.js` calls it: resume/start/submitEmailCode →
  enable; pause → disable.
- **Requires a Vercel env var:** `CRONJOB_API_KEY` (cron-job.org API key).
  Optional: `CRONJOB_CHECKER_JOB_ID` (defaults to `7809757`).
- **The CLI is logged into a different Vercel account than the project's team
  (`siddy-s-projects`), so this env var must be added via the Vercel dashboard
  UI** (Settings → Environment Variables → Production), then redeploy. Until
  then, pause/resume from the dashboard will error with "CRONJOB_API_KEY is not
  configured".

## Silent-failure watchdog (GitHub Actions limit detection)

**Problem:** The repo is **private**, so Actions minutes are capped. At a 5-min
cadence with ~2-min runs (~500+ min/day) the free monthly allowance is exhausted
in days. When the limit is hit, cron-job.org's dispatch still succeeds (the run
is created), but GitHub **never starts the job** — it's instantly marked
`failure` with zero steps. So `check.js` never runs, `status.json` goes stale, no
availability email can fire, and — because the daily summary also runs on Actions
— even the summary stops. Total silent failure.

**Solution (built):** A Vercel-hosted watchdog that survives Actions outages.
- `dashboard/app/api/watchdog/route.js` — reads `control.json` and the recent
  `check-availability.yml` runs. Returns HTTP **200** when healthy or
  intentionally paused, and **503** when checks are silently failing (latest run
  failed / no recent run / GitHub unreadable).
- `getRecentCheckRuns()` added to `dashboard/lib/githubStatus.js`.
- cron-job.org job **"Accom checker health watchdog"** (jobId 7902174) pings the
  endpoint every 15 min with **failure + recovery email notifications** enabled
  (`onFailureCount: 2`, so it needs ~30 min of failures before emailing — avoids
  one-off flakes). cron-job.org sends the alert email, so no SMTP is needed in
  the dashboard.
- Auth: the endpoint and job share `CRON_SECRET` (now set in Vercel; sent as a
  Bearer header by the job).

**This only DETECTS the problem.** To actually stop hitting the limit, still do
one of: make the repo public (free unlimited Actions minutes), reduce the check
frequency, or raise the GitHub spending limit. See action items below.

## Security audit before going public (2026-06-24)

Audited working tree + full git history (all branches) for exposed credentials/PII.

- **`master` (code): CLEAN.** No secrets/PII; no `.env`/cookie/key files ever
  committed (only `.env.example`).
- **`status` branch: contained PII in history.** Across its ~18.5k commits, some
  older `status.json`/`events.json` error messages embedded scraped account-page
  text including the owner's name, student ID, and LSE email. The *current* HEAD
  of the branch is clean, but the **history is not**.
- **Implication:** GitHub has no per-branch visibility — making the repo public
  exposes the `status` branch history too.

Remediation:
- **Done:** `src/status.js` now redacts PII (`redactPii`/`sanitizeDeep`) at the
  single write choke point, so future status/events writes can't leak name/ID/
  email even on a public repo.
- **STILL REQUIRED before making the repo public:** wipe the `status` branch
  history (replace with one clean commit) — the existing history still contains
  PII. This is a destructive force-replace, so it needs explicit owner approval.

## Open issues / what still needs to change

### 1. Vercel free-tier deployment quota (HIGH)
The checker commits to the `status` branch every ~5 min. Vercel was building a
deployment for each of those commits — ~100+/day — which **hit the free-tier
limit of 100 deployments/day** and blocked real production deploys for 24h.

- **Fix applied:** `dashboard/vercel.json` disables deploys for the `status`
  branch. Verify in the Vercel dashboard that `status`-branch deploys stop.
- **Action:** Once the 24h quota window resets, redeploy `master` so the new
  `/api/summary` endpoint and the 2-min interval go live. Until then the new
  endpoint is **not** live on Vercel.

### 2. cron-job.org jobs (DONE — verify after Vercel/quota resets)
Both jobs are configured and enabled:
- **Checker** (jobId 7809757) — POST GitHub dispatch, every 5 min, Europe/London.
- **Daily summary** (jobId 7833387) — POST GitHub dispatch, 23:55 Europe/London.

Both carry a GitHub PAT in their request headers. **If that PAT expires or is
rotated, both jobs break** — update them with `scripts/setup-cronjobs.mjs`.

### 3. Why the summary showed only ~18 runs (INVESTIGATE)
Expected ~288 runs/day at a 5-min cadence, but the summary reported 18. With the
corrected understanding (cron-job.org dispatches GitHub directly), the most
likely causes are:
- **Concurrency cancellation:** `check-availability.yml` has
  `concurrency.group` with `cancel-in-progress: false`. If a run hangs (e.g.
  waiting up to `MFA_WAIT_MS`=4 min for Authenticator, or the 15-min timeout),
  dispatches that arrive while one is running get queued, and GitHub keeps only
  one pending run per group — extra dispatches are dropped/canceled.
- **The job had not been running a full day** when that summary was generated.
- **Run-history pagination/window** in `src/summary.js` (now counts both event
  types, deduped, London calendar day). If counts still look low, raise the page
  cap.

Action: check the GitHub Actions run list for canceled/queued runs to confirm
whether concurrency is the bottleneck. If so, consider shortening `MFA_WAIT_MS`
or relaxing the concurrency group.

### 4. Login session / MFA durability (MEDIUM)
The checker relies on a cached LSE cookie session (`.auth`, seeded from
`LSE_COOKIES_B64`). When it expires, a run blocks waiting for MFA/email-code
input via the dashboard. If sessions expire often, runs will stall and inflate
the "needs_mfa" / "needs_email_code" counts.

## Required environment / secrets

GitHub Actions secrets (checker + summary): `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO`, `LSE_EMAIL`,
`LSE_PASSWORD`, `LSE_COOKIES_B64`.

Vercel env vars (dashboard): `CRON_SECRET`, `GITHUB_STATUS_TOKEN`,
`GITHUB_STATUS_WRITE_TOKEN`, `GITHUB_STATUS_REPO`, `GITHUB_STATUS_BRANCH`,
`CRONJOB_API_KEY` (for pause/resume), and optionally `CRONJOB_CHECKER_JOB_ID`
(defaults to `7809757`).

Dashboard URL: `https://lse-accom-checker-siddharthg0812-1399-siddy-s-projects.vercel.app`

## Setting up cron-job.org via API

Already done this session. To re-create or update the jobs (e.g. after rotating
the GitHub PAT), use `scripts/setup-cronjobs.mjs`:

```bash
CRONJOB_API_KEY=...           # from https://console.cron-job.org (Settings → API)
GITHUB_DISPATCH_TOKEN=...     # GitHub PAT with actions:write on the repo
# optional: GITHUB_REPO, GITHUB_REF, SUMMARY_HOUR, SUMMARY_MINUTE, TIMEZONE

node scripts/setup-cronjobs.mjs
```

It upserts (matches by title/url):
- "Accom checker GitHub Actions dispatch" → POST `check-availability.yml/dispatches`, every 5 min, Europe/London.
- "Accom daily summary GitHub Actions dispatch" → POST `daily-summary.yml/dispatches`, 23:55 Europe/London.

The GitHub PAT is sent in the request headers. Treat both the cron-job.org API
key and the GitHub PAT as secrets — never commit them.

## TODO / Action items for the next agent

Priority order. Most code changes are already committed/pushed to `master`; the
remaining work is mostly verification and the run-count investigation.

### P0 — Stop exhausting GitHub Actions minutes (prevention)
The watchdog now *detects* the limit being hit (emails via cron-job.org job
7902174), but the private repo still burns ~500+ Actions min/day at a 5-min
cadence and will keep hitting the cap. Pick a prevention:
- **Make the repo public** (recommended) → unlimited free Actions minutes.
  Secrets live in GitHub Secrets, not code, so they stay private. The `status`
  branch (status.json/events.json) and source become visible — confirm that's ok.
- **Reduce frequency** (e.g. every 15-20 min) by editing the checker cron-job.org
  job (7809757) schedule via `scripts/setup-cronjobs.mjs` or the console.
- **Raise the GitHub spending limit** / add a payment method (Billing & plans).

### P0 — Make dashboard pause/resume work end-to-end
The code is committed: pause/resume toggles the cron-job.org checker job (7809757)
via `setCheckerCronEnabled`. To activate it:
1. Add `CRONJOB_API_KEY` (cron-job.org API key) to the Vercel project
   (`siddy-s-projects/lse-accom-checker`) → Settings → Environment Variables →
   Production. The local `vercel` CLI is logged into a different account, so this
   must be done in the Vercel dashboard UI (or after `vercel login` to the right
   account). Optionally also set `CRONJOB_CHECKER_JOB_ID` (defaults to 7809757).
2. Redeploy `master` so the new control route is live.
3. Test: pause from the dashboard → confirm cron-job.org job 7809757 flips to
   disabled and Actions runs stop; resume → it re-enables and a run dispatches.

Note: the checker job 7809757 is **currently disabled** (paused manually on
2026-06-23). Resuming from the dashboard (once the env var is set + deployed)
will re-enable it, or re-enable it manually in the cron-job.org console.

### P0 — Verify the daily summary is now correct
1. **Wait for the next daily summary email** (sent ~23:55 Europe/London by
   cron-job.org jobId 7833387 → `daily-summary.yml`). Confirm the run-count
   lines now reflect the true number of checks (expect roughly 288/day if the
   5-min checker runs cleanly), not ~18.
2. If counts are still low, do the P1 investigation below.

### P1 — Investigate the low run count (the original complaint)
The checker is dispatched every 5 min, but the summary reported only ~18 runs.
Most likely cause: GitHub **concurrency** drops dispatches while a run is busy.
- Inspect recent `check-availability.yml` runs in GitHub Actions. Count how many
  are `completed/success` vs `cancelled`/never-created on a given day.
- Check typical run duration. The workflow `timeout-minutes: 15` and
  `MFA_WAIT_MS=240000` (4 min) mean a run waiting on Authenticator/email code
  can occupy the concurrency group long enough to drop several 5-min dispatches.
- Candidate fixes (pick based on findings):
  - Shorten `MFA_WAIT_MS` so stuck logins fail fast instead of blocking the queue.
  - Reconsider the `concurrency` block in `check-availability.yml` (e.g. allow
    more overlap, or keep it but make runs fail fast).
  - If GitHub-side dispatch is being throttled/dropped, consider spacing or
    reducing cadence.
- After any change, re-verify with the next day's summary.

### P2 — Vercel deploy + quota
1. Confirm `dashboard/vercel.json` stopped the `status`-branch deployments (the
   ~100/day canceled previews that exhausted the free-tier quota). Check the
   Vercel project's deployment list.
2. Once the 24h quota window has reset, trigger a production deploy of `master`
   (push, or `vercel --prod` from the repo root with `.vercel` linked there).
   Note: the project's Root Directory is `dashboard`, so the CLI must run from
   the repo root, not from inside `dashboard/`.
3. This deploy only matters for the dashboard UI / MFA-code submission and the
   (currently-unused) `/api/cron` + `/api/summary` endpoints. The checker itself
   does NOT depend on Vercel.

### P3 — Login/MFA durability (only if runs stall on auth)
- If summaries show recurring `needs_mfa` / `needs_email_code` / `login_failed`,
  the cached LSE session (`LSE_COOKIES_B64` → `.auth`) is expiring. Refresh the
  cookies (run `npm run login` locally, re-encode, update the
  `LSE_COOKIES_B64` GitHub secret).

### Secrets hygiene (optional but recommended)
- The GitHub PAT used by both cron-job.org jobs was exposed in chat during
  setup. Consider rotating it on GitHub, then re-run `scripts/setup-cronjobs.mjs`
  with the new `GITHUB_DISPATCH_TOKEN` to update both jobs.

### Do NOT
- Re-add GitHub-native `schedule:` triggers (they were removed on purpose;
  GitHub cron was unreliable). All scheduling stays on cron-job.org.
- Commit any secrets (GitHub PAT, cron-job.org API key, SMTP creds).
