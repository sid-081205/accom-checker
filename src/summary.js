require("dotenv").config();

const nodemailer = require("nodemailer");

const STATUS_BRANCH = process.env.STATUS_BRANCH || "status";
const CHECK_WORKFLOW = "check-availability.yml";

async function githubRequest(route, { raw = false } = {}) {
  const response = await fetch(`https://api.github.com${route}`, {
    headers: {
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub read failed: ${response.status} ${response.statusText}: ${text}`);
  }

  return response.json();
}

async function readStatusFile(filePath, fallback) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return fallback;

  return (
    (await githubRequest(
      `/repos/${process.env.GITHUB_REPOSITORY}/contents/${filePath}?ref=${STATUS_BRANCH}`,
      { raw: true }
    )) || fallback
  );
}

async function readTodayWorkflowRuns() {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return [];

  const today = londonDate(new Date());
  const runs = [];

  for (const event of ["schedule", "workflow_dispatch"]) {
    for (let page = 1; page <= 10; page += 1) {
      const payload = await githubRequest(
        `/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${CHECK_WORKFLOW}/runs?event=${event}&per_page=100&page=${page}`
      );
      const pageRuns = payload?.workflow_runs || [];
      if (pageRuns.length === 0) break;

      runs.push(...pageRuns.filter((run) => londonDate(run.created_at) === today));

      const hasOlderRuns = pageRuns.some((run) => londonDate(run.created_at) !== today);
      if (hasOlderRuns) break;
    }
  }

  return runs;
}

function londonDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function stateCount(events, state) {
  return events.filter((event) => event.state === state).length;
}

async function sendMail(subject, text) {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_TO"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing email environment variables: ${missing.join(", ")}`);
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: process.env.EMAIL_TO,
    subject,
    text,
  });
}

async function main() {
  const [status, events, workflowRuns] = await Promise.all([
    readStatusFile("status.json", null),
    readStatusFile("events.json", []),
    readTodayWorkflowRuns(),
  ]);

  const today = londonDate(new Date());
  const todaysEvents = events.filter((event) => londonDate(event.at) === today);
  const completedCheckCount = todaysEvents.filter((event) =>
    ["ok", "availability_found", "error", "login_failed", "needs_mfa", "needs_email_code"].includes(
      event.state
    )
  ).length;
  const workflowDispatchCount = workflowRuns.length;
  const completedWorkflowCount = workflowRuns.filter((run) => run.status === "completed").length;
  const successfulWorkflowCount = workflowRuns.filter((run) => run.conclusion === "success").length;
  const failedWorkflowCount = workflowRuns.filter((run) => run.conclusion === "failure").length;

  const text = [
    `Accom checker daily summary for ${today}`,
    "",
    `Cron/workflow jobs started: ${workflowDispatchCount}`,
    `Cron/workflow jobs completed: ${completedWorkflowCount}`,
    `Cron/workflow jobs succeeded: ${successfulWorkflowCount}`,
    `Cron/workflow jobs failed: ${failedWorkflowCount}`,
    `Checks completed by scraper: ${completedCheckCount}`,
    `No-availability checks: ${stateCount(todaysEvents, "ok")}`,
    `Availability signals: ${stateCount(todaysEvents, "availability_found")}`,
    `Authenticator prompts: ${stateCount(todaysEvents, "needs_mfa")}`,
    `Email-code prompts: ${stateCount(todaysEvents, "needs_email_code")}`,
    `Errors: ${stateCount(todaysEvents, "error") + stateCount(todaysEvents, "login_failed")}`,
    "",
    `Latest state: ${status?.state || "unknown"}`,
    `Latest message: ${status?.message || "No status message"}`,
    status?.workflowUrl ? `Latest workflow: ${status.workflowUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await sendMail(`Accom checker daily summary - ${today}`, text);
  console.log(`Sent daily summary for ${today}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
