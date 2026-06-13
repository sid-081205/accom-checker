import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../lib/auth";
import { dispatchChecker, writeControl } from "../../../lib/githubStatus";

export async function POST(request) {
  const cookieStore = await cookies();
  if (!isAuthenticated(cookieStore)) {
    return NextResponse.redirect(new URL("/login", request.url), 303);
  }

  const formData = await request.formData();
  const action = formData.get("action");
  const enabled = action === "start";

  await writeControl({
    enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: "dashboard",
  });

  if (enabled) {
    await dispatchChecker();
  }

  return NextResponse.redirect(new URL("/", request.url), 303);
}
