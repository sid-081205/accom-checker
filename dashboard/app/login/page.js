export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const hasError = params?.error === "1";

  return (
    <main className="shell auth-shell">
      <section className="card auth-card">
        <p className="eyebrow">Accom Checker</p>
        <h1>Status Dashboard</h1>
        <p className="muted">Enter the dashboard password to view checker status.</p>

        {hasError ? <p className="alert error">Incorrect password.</p> : null}

        <form action="/api/login" method="post" className="stack">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" />
          <button type="submit">Open Dashboard</button>
        </form>
      </section>
    </main>
  );
}
