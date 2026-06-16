import { NextResponse } from "next/server";
import { dispatchSummary } from "../../../lib/githubStatus";

function authorized(request) {
  const configuredToken = process.env.CRON_SECRET;
  if (!configuredToken) return false;

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  return queryToken === configuredToken || bearer === configuredToken;
}

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  await dispatchSummary();

  return NextResponse.json({ ok: true, dispatched: true });
}
