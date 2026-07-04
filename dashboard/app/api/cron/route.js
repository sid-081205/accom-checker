import { NextResponse } from "next/server";
import { dispatchChecker, getControl, getStatus, writeDashboardStatus } from "../../../lib/githubStatus";

// Must stay below the fastest schedule the dashboard can select (2 minutes),
// otherwise this throttle would skip legitimate dispatches on that cadence.
const MIN_CHECK_INTERVAL_MS = 90 * 1000;

function authorized(request) {
  const configuredToken = process.env.CRON_SECRET;
  if (!configuredToken) return false;

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  return queryToken === configuredToken || bearer === configuredToken;
}

function lastCheckTime(status) {
  const value = status?.checkedAt || status?.updatedAt;
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const [control, status] = await Promise.all([getControl(), getStatus()]);
  if (!control.enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: "paused" });
  }

  const ageMs = Date.now() - lastCheckTime(status);
  if (ageMs >= 0 && ageMs < MIN_CHECK_INTERVAL_MS) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "recent_check",
      ageSeconds: Math.round(ageMs / 1000),
    });
  }

  await writeDashboardStatus({
    state: "starting",
    message: "Checker was started by cron-job.org.",
    updatedAt: new Date().toISOString(),
  });
  await dispatchChecker();

  return NextResponse.json({ ok: true, dispatched: true });
}
