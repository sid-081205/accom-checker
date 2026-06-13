import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isAuthenticated } from "../lib/auth";
import { getControl, getEvents, getStatus } from "../lib/githubStatus";

export const dynamic = "force-dynamic";

function formatDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Europe/London",
  }).format(new Date(value));
}

function stateLabel(state) {
  const labels = {
    starting: "Running",
    ok: "No Availability",
    availability_found: "Availability Found",
    needs_mfa: "Needs Authenticator Approval",
    needs_email_code: "Needs Email Code",
    login_failed: "Login Failed",
    paused: "Paused",
    error: "Error",
  };
  return labels[state] || "Unknown";
}

function stateClass(state) {
  if (state === "availability_found") return "good";
  if (state === "needs_mfa" || state === "needs_email_code" || state === "paused") return "warn";
  if (state === "error" || state === "login_failed") return "bad";
  return "neutral";
}

export default async function DashboardPage({ searchParams }) {
  const cookieStore = await cookies();
  if (!isAuthenticated(cookieStore)) {
    redirect("/login");
  }

  const params = await searchParams;
  const [status, events, control] = await Promise.all([getStatus(), getEvents(), getControl()]);
  const currentState = status?.state || "unknown";

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">Accom Checker</p>
          <h1>LSE accommodation monitor</h1>
          <p className="muted">Auto-refreshes every 60 seconds.</p>
        </div>
        <form action="/api/logout" method="post">
          <button className="secondary" type="submit">
            Log out
          </button>
        </form>
      </header>

      <section className={`hero card ${stateClass(currentState)}`}>
        <p className="eyebrow">Current Status</p>
        <h2>{stateLabel(currentState)}</h2>
        <p>{status?.message || "No status has been written yet."}</p>
        {params?.controlError ? <p className="alert error">{params.controlError}</p> : null}
      </section>

      <section className="grid">
        <article className="card">
          <p className="eyebrow">Process Control</p>
          <h3>{control.enabled ? "Running" : "Paused"}</h3>
          <p className="muted">
            {control.enabled
              ? "Scheduled checks are allowed to run."
              : "Scheduled checks exit without opening LSE."}
          </p>
          <form action="/api/control" method="post" className="button-row">
            <button name="action" value="start" type="submit">
              Start
            </button>
            <button className="secondary" name="action" value="stop" type="submit">
              Stop
            </button>
          </form>
        </article>

        <article className="card">
          <p className="eyebrow">Last Run</p>
          <h3>{formatDate(status?.checkedAt || status?.updatedAt)}</h3>
          {status?.workflowUrl ? (
            <a href={status.workflowUrl} target="_blank" rel="noreferrer">
              Open GitHub Actions run
            </a>
          ) : (
            <p className="muted">No workflow link yet.</p>
          )}
        </article>

        <article className="card">
          <p className="eyebrow">Availability</p>
          <h3>{status?.noAvailability === false ? "Potentially live" : "No rooms seen"}</h3>
          <p className="muted">Room rows detected: {status?.roomCount ?? 0}</p>
        </article>

        <article className="card">
          <p className="eyebrow">Authenticator</p>
          {status?.state === "needs_mfa" && status?.mfaCode ? (
            <>
              <h3 className="mfa-code">{status.mfaCode}</h3>
              <p className="muted">Approve this number in Microsoft Authenticator.</p>
            </>
          ) : status?.state === "needs_email_code" ? (
            <>
              <h3>Email code needed</h3>
              <p className="muted">
                Enter the code from your inbox while the GitHub Action is still running.
              </p>
              <form action="/api/control" method="post" className="stack">
                <label htmlFor="emailCode">Email verification code</label>
                <input id="emailCode" name="emailCode" inputMode="numeric" autoComplete="one-time-code" />
                <button name="action" value="submitEmailCode" type="submit">
                  Submit Code
                </button>
              </form>
            </>
          ) : (
            <>
              <h3>No approval needed</h3>
              <p className="muted">The saved LSE session is currently enough or no run is active.</p>
            </>
          )}
        </article>
      </section>

      <section className="card">
        <p className="eyebrow">Latest Details</p>
        <pre>{status?.summary || status?.error || "Nothing to show yet."}</pre>
      </section>

      <section className="card">
        <p className="eyebrow">Recent Events</p>
        {events.length > 0 ? (
          <ol className="events">
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <span>{formatDate(event.at)}</span>
                <strong>{stateLabel(event.state)}</strong>
                <p>{event.message}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No events have been recorded yet.</p>
        )}
      </section>

      <meta httpEquiv="refresh" content="60" />
    </main>
  );
}
