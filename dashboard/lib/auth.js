import crypto from "crypto";

export const SESSION_COOKIE = "accom_dashboard_session";

function dashboardPassword() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    throw new Error("DASHBOARD_PASSWORD is not configured.");
  }
  return password;
}

export function sessionValue() {
  return crypto.createHmac("sha256", dashboardPassword()).update("dashboard-session").digest("hex");
}

export function isAuthenticated(cookieStore) {
  return cookieStore.get(SESSION_COOKIE)?.value === sessionValue();
}
