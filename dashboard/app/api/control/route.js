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

  try {
    await writeControl({
      enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: "dashboard",
    });

    if (enabled) {
      await dispatchChecker();
    }
  } catch (error) {
    const url = new URL("/", request.url);
    url.searchParams.set("controlError", error.message.slice(0, 180));
    return NextResponse.redirect(url, 303);
  }

  return NextResponse.redirect(new URL("/", request.url), 303);
}
