# Accom Checker

Checks the LSE student accommodation booking flow and emails when the availability page no longer says:

```text
No residences currently have availability
```

When the message disappears, the checker emails visible room rows from the page. If the site changes and no `.RoomRow` entries are found, it sends a visible page summary instead.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create local email config:

   ```sh
   cp .env.example .env
   ```

3. Edit `.env` with SMTP details. For Gmail, use an app password rather than your normal Google password.

4. Save an authenticated LSE session:

   ```sh
   npm run login
   ```

   Complete the LSE login in the browser window, navigate until you can see the accommodation dashboard or rooms page, then press Enter in the terminal. The saved Selenium cookies are written to `.auth/lse-cookies.json`, which is ignored by git.

5. For GitHub Actions, upload those cookies as a secret:

   ```sh
   base64 -i .auth/lse-cookies.json | gh secret set LSE_COOKIES_B64
   ```

## Run

```sh
npm run check
```

The script follows the current booking flow:

- Opens the LSE accommodation landing page.
- Uses the saved login session.
- Clicks `Continue Booking` if shown.
- Selects `No` for urbanest Westminster Bridge if that question appears.
- Confirms the pre-filled `About You` page if it appears.
- Checks the `Select your room type` availability page.

## GitHub Actions

The repository includes a scheduled workflow at `.github/workflows/check-availability.yml`. It runs every 5 minutes, restores cached Selenium cookies, checks availability, and sends an email only when the no-availability message disappears.

Set these GitHub Secrets:

```sh
gh secret set LSE_EMAIL --body "your-lse-email"
gh secret set LSE_PASSWORD --body "your-lse-password"
gh secret set KV_REST_API_URL --body "your-vercel-kv-rest-api-url"
gh secret set KV_REST_API_TOKEN --body "your-vercel-kv-rest-api-token"
```

The SMTP secrets are also required: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, and `EMAIL_TO`.

`LSE_COOKIES_B64` is optional once `LSE_EMAIL` and `LSE_PASSWORD` are configured. If cookies expire, Selenium starts the Microsoft login flow, writes the Authenticator number to the dashboard, emails the same number, waits for approval, then caches refreshed cookies for later runs.

## Dashboard

The Vercel dashboard lives in `dashboard/`. It shows:

- latest checker state
- last run time
- workflow run link
- room count and latest summary
- Microsoft Authenticator number when approval is needed
- recent status events

Deploy by importing this repo into Vercel. The root `vercel.json` builds the `dashboard/` app.

Create a Vercel KV store and add these Vercel environment variables:

```sh
DASHBOARD_PASSWORD=choose-a-dashboard-password
KV_REST_API_URL=your-vercel-kv-rest-api-url
KV_REST_API_TOKEN=your-vercel-kv-rest-api-token
```

Use the same `KV_REST_API_URL` and `KV_REST_API_TOKEN` values as GitHub Secrets so the checker can write status and the dashboard can read it.

## Local Schedule

On macOS, run this every few minutes with cron:

```cron
*/5 * * * * cd "/Users/siddharthgianchandani/accom checker" && /usr/bin/env npm run check >> checker.log 2>&1
```

If LSE expires the session, run `npm run login` again.
