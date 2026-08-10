require("dotenv").config();

const nodemailer = require("nodemailer");
const { londonDate, readDailyStats } = require("./status");

const STATUS_BRANCH = process.env.STATUS_BRANCH || "status";
const CHECK_WORKFLOW = "check-availability.yml";
const MAX_RUN_PAGES = 15;

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

  if (raw) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return response.json();
}

async function readStatusFile(filePath, fallback) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return fallback;

  try {
    return (
      (await githubRequest(
        `/repos/${process.env.GITHUB_REPOSITORY}/contents/${filePath}?ref=${STATUS_BRANCH}`,
        { raw: true }
      )) || fallback
    );
  } catch (error) {
    console.warn(`Status file read failed for ${filePath}: ${error.message}`);
    return fallback;
  }
}

async function readTodayWorkflowRuns(today = londonDate(new Date())) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return [];

  const byId = new Map();

  for (const event of ["schedule", "workflow_dispatch"]) {
    for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
      const payload = await githubRequest(
        `/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${CHECK_WORKFLOW}/runs?event=${event}&per_page=100&page=${page}`
      );
      const pageRuns = payload?.workflow_runs || [];
      if (pageRuns.length === 0) break;

      for (const run of pageRuns) {
        if (londonDate(run.created_at) === today) {
          byId.set(run.id, run);
        }
      }

      const oldest = pageRuns[pageRuns.length - 1];
      if (oldest && londonDate(oldest.created_at) < today) break;
    }
  }

  return [...byId.values()];
}

function stateCount(events, state) {
  return events.filter((event) => event.state === state).length;
}

function summarizeWorkflowRuns(workflowRuns) {
  const started = workflowRuns.length;
  const completed = workflowRuns.filter((run) => run.status === "completed").length;
  const succeeded = workflowRuns.filter((run) => run.conclusion === "success").length;
  const failed = workflowRuns.filter((run) => run.conclusion === "failure").length;
  const cancelled = workflowRuns.filter((run) => run.conclusion === "cancelled").length;
  const skipped = workflowRuns.filter((run) => run.conclusion === "skipped").length;
  const timedOut = workflowRuns.filter((run) => run.conclusion === "timed_out").length;
  const otherCompleted = workflowRuns.filter(
    (run) =>
      run.status === "completed" &&
      !["success", "failure", "cancelled", "skipped", "timed_out"].includes(run.conclusion)
  ).length;
  const inProgress = workflowRuns.filter((run) => run.status !== "completed").length;

  return {
    started,
    completed,
    succeeded,
    failed,
    cancelled,
    skipped,
    timedOut,
    otherCompleted,
    inProgress,
  };
}

function buildHealthLine(workflow, checksCompleted) {
  if (workflow.started === 0) {
    return "Health: CRITICAL — no checker workflow dispatches were found for today.";
  }

  if (workflow.cancelled > 0 && workflow.cancelled >= workflow.succeeded) {
    return `Health: DEGRADED — ${workflow.cancelled} dispatches were cancelled without running (often a stuck concurrency slot). Only ${checksCompleted} checks actually scraped.`;
  }

  if (workflow.failed > 0 && workflow.succeeded === 0) {
    return "Health: CRITICAL — every completed workflow failed; availability alerts cannot fire.";
  }

  if (checksCompleted === 0) {
    return "Health: CRITICAL — workflows ran but no scraper outcomes were recorded.";
  }

  if (workflow.failed > 0) {
    return `Health: OK with ${workflow.failed} failed workflow(s); ${checksCompleted} checks completed.`;
  }

  return `Health: OK — ${checksCompleted} availability checks completed.`;
}

function buildSummaryText({ today, status, todaysEvents, workflow, dayStats }) {
  const byState = dayStats?.byState || {};
  const checksFromStats = Number(dayStats?.checksCompleted || 0);
  const checksFromEvents = todaysEvents.filter((event) =>
    ["ok", "availability_found", "error", "site_error", "login_failed"].includes(event.state)
  ).length;
  // Prefer durable daily-stats counters; fall back to events for older days.
  const useStats = checksFromStats > 0;
  const checksCompleted = useStats ? checksFromStats : checksFromEvents;

  const noAvailability = useStats ? Number(byState.ok || 0) : stateCount(todaysEvents, "ok");
  const availabilitySignals = useStats
    ? Number(byState.availability_found || 0)
    : stateCount(todaysEvents, "availability_found");
  const errors = useStats
    ? Number(byState.error || 0) +
      Number(byState.site_error || 0) +
      Number(byState.login_failed || 0)
    : stateCount(todaysEvents, "error") +
      stateCount(todaysEvents, "site_error") +
      stateCount(todaysEvents, "login_failed");
  const authenticatorPrompts = stateCount(todaysEvents, "needs_mfa");
  const emailCodePrompts = stateCount(todaysEvents, "needs_email_code");

  return [
    `Accom checker daily summary for ${today}`,
    "",
    "Workflow dispatches (cron → GitHub Actions)",
    `  started: ${workflow.started}`,
    `  completed: ${workflow.completed}`,
    `  succeeded (job ran): ${workflow.succeeded}`,
    `  failed: ${workflow.failed}`,
    `  cancelled (superseded / never ran): ${workflow.cancelled}`,
    workflow.timedOut ? `  timed out: ${workflow.timedOut}` : "",
    workflow.skipped ? `  skipped: ${workflow.skipped}` : "",
    workflow.otherCompleted ? `  other completed: ${workflow.otherCompleted}` : "",
    workflow.inProgress ? `  still in progress at summary time: ${workflow.inProgress}` : "",
    "",
    "Availability checks that actually scraped",
    `  completed: ${checksCompleted}`,
    `  no availability: ${noAvailability}`,
    `  availability signals: ${availabilitySignals}`,
    `  authenticator prompts: ${authenticatorPrompts}`,
    `  email-code prompts: ${emailCodePrompts}`,
    `  errors: ${errors}`,
    "",
    buildHealthLine(workflow, checksCompleted),
    `Latest state: ${status?.state || "unknown"}`,
    `Latest message: ${status?.message || "No status message"}`,
    status?.workflowUrl ? `Latest workflow: ${status.workflowUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
  const today = londonDate(new Date());
  const [status, events, workflowRuns, dailyStats] = await Promise.all([
    readStatusFile("status.json", null),
    readStatusFile("events.json", []),
    readTodayWorkflowRuns(today),
    readDailyStats().catch(() => ({})),
  ]);

  const todaysEvents = (events || []).filter((event) => londonDate(event.at) === today);
  const workflow = summarizeWorkflowRuns(workflowRuns);
  const dayStats = dailyStats?.[today] || null;

  const text = buildSummaryText({
    today,
    status,
    todaysEvents,
    workflow,
    dayStats,
  });

  await sendMail(`Accom checker daily summary - ${today}`, text);
  console.log(`Sent daily summary for ${today}.`);
  console.log(text);
}

module.exports = {
  buildHealthLine,
  buildSummaryText,
  summarizeWorkflowRuns,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
