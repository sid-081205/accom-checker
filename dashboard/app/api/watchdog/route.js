import { NextResponse } from "next/server";
import { getControl, getRecentCheckRuns } from "../../../lib/githubStatus";

// If the most recent checker run is older than this, the schedule has likely
// stopped firing (e.g. cron-job.org disabled, or dispatches not landing).
const MAX_RUN_AGE_MS = 20 * 60 * 1000;

function authorized(request) {
  const configuredToken = process.env.CRON_SECRET;
  if (!configuredToken) return false;

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  return queryToken === configuredToken || bearer === configuredToken;
}

// Health watchdog for the availability checker.
//
// Returns HTTP 200 when the checker is healthy (or intentionally paused), and a
// non-2xx status when checks are silently failing - e.g. the GitHub Actions
// spending/usage limit has been hit (runs get created but the job never starts,
// so check.js never runs, never updates status, and never emails). A cron-job.org
// job pings this endpoint with failure notifications enabled, so cron-job.org
// emails the alert. This runs on Vercel, so it keeps working even when GitHub
// Actions is unavailable.
export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const control = await getControl();
  if (!control.enabled) {
    return NextResponse.json({ ok: true, paused: true });
  }

  let runs;
  try {
    runs = await getRecentCheckRuns(10);
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: "github_read_failed", error: error.message },
      { status: 503 }
    );
  }

  if (!runs || runs.length === 0) {
    return NextResponse.json({ ok: false, reason: "no_runs" }, { status: 503 });
  }

  const latest = runs[0];
  const ageMs = Date.now() - new Date(latest.created_at).getTime();
  const ageMinutes = Math.round(ageMs / 60000);

  if (ageMs > MAX_RUN_AGE_MS) {
    return NextResponse.json(
      {
        ok: false,
        reason: "no_recent_runs",
        latestRunAgeMinutes: ageMinutes,
        latestRunUrl: latest.html_url,
      },
      { status: 503 }
    );
  }

  // A completed run with conclusion "failure" means the checker did not run
  // successfully. The most common cause is the Actions spending/usage limit
  // (job not started), but it also covers repeated checker crashes.
  if (latest.status === "completed" && latest.conclusion !== "success") {
    return NextResponse.json(
      {
        ok: false,
        reason: "latest_run_failed",
        conclusion: latest.conclusion,
        latestRunAgeMinutes: ageMinutes,
        latestRunUrl: latest.html_url,
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    status: latest.status,
    conclusion: latest.conclusion,
    latestRunAgeMinutes: ageMinutes,
    latestRunUrl: latest.html_url,
  });
}
