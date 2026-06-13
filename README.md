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

## Schedule

On macOS, run this every few minutes with cron:

```cron
*/5 * * * * cd "/Users/siddharthgianchandani/accom checker" && /usr/bin/env npm run check >> checker.log 2>&1
```

If LSE expires the session, run `npm run login` again.
