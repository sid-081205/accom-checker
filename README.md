# Accom Checker

Automated monitor for LSE student accommodation availability.

The checker watches the LSE accommodation booking flow and sends an email when the usual no-availability message disappears. It also keeps a small dashboard up to date with the latest run, availability status, recent events, and start/stop controls.

Dashboard: https://lse-accom-checker-siddharthg0812-1399-siddy-s-projects.vercel.app

## What It Does

- Checks the LSE accommodation site on a recurring schedule.
- Sends an availability email only when there may be rooms available.
- Sends a daily summary email with run counts, checker results, auth prompts, and errors.
- Shows current state, last run time, room count, and recent events in the dashboard.
- Supports pausing and restarting checks from the dashboard.
- Surfaces Microsoft Authenticator or email-code prompts when the saved session needs attention.

## Dashboard

The dashboard is the main way to inspect the project. It shows whether the checker is running, when it last checked, when the next scheduled run should happen, and what the latest LSE page summary looked like.

Recent events are kept collapsible so the page stays readable while still preserving history.

## Alerts

Availability alerts are intentionally conservative: no email is sent while the page still says there are no residences available. If that message disappears, the checker sends the visible room information or a page summary for review.

Daily summaries report how many scheduler jobs ran, how many checks completed, and whether anything unusual happened.
