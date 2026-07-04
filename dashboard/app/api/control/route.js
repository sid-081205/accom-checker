import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../lib/auth";
import {
  CHECKER_INTERVAL_OPTIONS,
  dispatchChecker,
  setCheckerCronEnabled,
  setCheckerCronInterval,
  writeControl,
  writeDashboardStatus,
} from "../../../lib/githubStatus";

export async function POST(request) {
  const cookieStore = await cookies();
  if (!isAuthenticated(cookieStore)) {
    return NextResponse.redirect(new URL("/login", request.url), 303);
  }

  const formData = await request.formData();
  const action = formData.get("action");
  const emailCode = `${formData.get("emailCode") || ""}`.trim();
  const enabled = action === "start";

  try {
    if (action === "setInterval") {
      const interval = Number(`${formData.get("intervalMinutes") || ""}`.trim());
      if (!CHECKER_INTERVAL_OPTIONS.includes(interval)) {
        throw new Error(
          `Invalid check interval. Allowed: ${CHECKER_INTERVAL_OPTIONS.join(", ")} minutes.`
        );
      }
      await setCheckerCronInterval(interval);
      return NextResponse.redirect(new URL("/", request.url), 303);
    }

    if (action === "submitEmailCode") {
      await writeControl({
        enabled: true,
        emailCode,
        emailCodeUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: "dashboard",
      });
      await setCheckerCronEnabled(true);
      return NextResponse.redirect(new URL("/", request.url), 303);
    }

    await writeControl({
      enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: "dashboard",
    });

    if (enabled) {
      await writeDashboardStatus({
        state: "starting",
        message: "Checker was started from the dashboard. GitHub Actions run is being dispatched.",
        updatedAt: new Date().toISOString(),
      });
      await setCheckerCronEnabled(true);
      await dispatchChecker();
    } else {
      await setCheckerCronEnabled(false);
      await writeDashboardStatus({
        state: "paused",
        message: "Checker was paused from the dashboard. The 5-minute schedule is disabled.",
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    const url = new URL("/", request.url);
    url.searchParams.set("controlError", error.message.slice(0, 180));
    return NextResponse.redirect(url, 303);
  }

  return NextResponse.redirect(new URL("/", request.url), 303);
}
