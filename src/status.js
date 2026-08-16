const fs = require("fs/promises");
const path = require("path");

const STATUS_BRANCH = process.env.STATUS_BRANCH || "status";
const STATUS_PATH = ".state/status.json";
const EVENTS_PATH = ".state/events.json";
const CONTROL_PATH = ".state/control.json";
const DAILY_STATS_PATH = ".state/daily-stats.json";
const MAX_EVENTS = 2000;
const DAILY_STATS_RETENTION_DAYS = 14;
const WRITE_ATTEMPTS = 5;

// Terminal / noteworthy states kept in events.json for the daily summary.
// Intermediate login/progress noise is intentionally excluded so the rolling
// event log is not overwritten by 3 entries per check.
const EVENT_STATES = new Set([
  "ok",
  "availability_found",
  "error",
  "site_error",
  "login_failed",
  "needs_mfa",
  "needs_email_code",
  "paused",
]);

const CHECK_OUTCOME_STATES = new Set([
  "ok",
  "availability_found",
  "error",
  "site_error",
  "login_failed",
]);

function githubConfigured() {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);
}

function londonDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

// Status/events are persisted to a branch that may be published (public repo).
// Scraped page text can contain personal data (name, student ID, email, etc.),
// so redact known PII before anything is written.
function redactPii(value) {
  if (typeof value !== "string") return value;

  let out = value;

  if (process.env.LSE_EMAIL) {
    out = out.split(process.env.LSE_EMAIL).join("[redacted]");
  }

  // Any email address.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");

  // Labeled fields scraped from the LSE account / "About You" pages, e.g.
  // "STUDENT ID | 123456789", "NAME | JANE DOE", "EMAIL ADDRESS | x@y".
  out = out.replace(
    /\b(STUDENT ID|NAME|EMAIL ADDRESS|PREFERRED NAME|MOBILE NUMBER|PHONE|POSTCODE|ADDRESS|DATE OF BIRTH)\b(\s*[|:]\s*)([^|]*)/gi,
    (match, label, separator) => `${label}${separator}[redacted]`
  );

  return out;
}

function sanitizeDeep(value) {
  if (typeof value === "string") return redactPii(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, sanitizeDeep(val)]));
  }
  return value;
}

async function githubRequest(route, options = {}) {
  const response = await fetch(`https://api.github.com${route}`, {
    ...options,
    headers: {
      Accept: options.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`GitHub status request failed: ${response.status} ${response.statusText}: ${text}`);
    error.status = response.status;
    throw error;
  }

  if (options.raw) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return response.json();
}

function workflowUrl() {
  if (!process.env.GITHUB_SERVER_URL || !process.env.GITHUB_REPOSITORY || !process.env.GITHUB_RUN_ID) {
    return undefined;
  }

  return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}

async function ensureStatusBranch() {
  if (!githubConfigured()) return;

  const repo = process.env.GITHUB_REPOSITORY;
  const existing = await githubRequest(`/repos/${repo}/git/ref/heads/${STATUS_BRANCH}`);
  if (existing) return;

  await githubRequest(`/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${STATUS_BRANCH}`,
      sha: process.env.GITHUB_SHA,
    }),
  });
}

async function getRemoteFileMeta(filePath) {
  if (!githubConfigured()) return null;

  const repo = process.env.GITHUB_REPOSITORY;
  return githubRequest(`/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${STATUS_BRANCH}`);
}

async function writeRemoteJson(filePath, value, { sha } = {}) {
  if (!githubConfigured()) return;

  await ensureStatusBranch();
  const repo = process.env.GITHUB_REPOSITORY;
  const content = Buffer.from(JSON.stringify(value, null, 2)).toString("base64");
  const currentSha = sha === undefined ? (await getRemoteFileMeta(filePath))?.sha : sha;

  await githubRequest(`/repos/${repo}/contents/${encodeURIComponent(filePath)}`, {
    method: "PUT",
    body: JSON.stringify({
      branch: STATUS_BRANCH,
      message: `Update ${filePath} [skip ci]`,
      content,
      ...(currentSha ? { sha: currentSha } : {}),
    }),
  });
}

async function readRemoteJson(filePath, fallback) {
  if (!githubConfigured()) return fallback;

  try {
    const repo = process.env.GITHUB_REPOSITORY;
    const file = await githubRequest(
      `/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${STATUS_BRANCH}`,
      { raw: true }
    );
    return file ?? fallback;
  } catch (error) {
    // Never fail the checker because GitHub status reads are flaky (502s, etc.).
    console.warn(`Remote status read skipped for ${filePath}: ${error.message}`);
    return fallback;
  }
}

async function readLocalJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeLocalJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function safeStatusWrite(filePath, value) {
  await writeLocalJson(filePath, value);

  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    try {
      await writeRemoteJson(path.basename(filePath), value);
      return;
    } catch (error) {
      const conflict = error.status === 409;
      if (!conflict || attempt === WRITE_ATTEMPTS) {
        console.warn(`Remote status write skipped: ${error.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

async function writeStatus(partial) {
  const now = new Date().toISOString();
  const status = sanitizeDeep({
    updatedAt: now,
    workflowUrl: workflowUrl(),
    ...partial,
  });

  await safeStatusWrite(STATUS_PATH, status);
}

async function appendEvent(event) {
  if (event?.state && !EVENT_STATES.has(event.state)) {
    return;
  }

  const nextEvent = sanitizeDeep({
    at: new Date().toISOString(),
    ...event,
  });

  // Read-merge-write with conflict retries so overlapping check runs do not
  // clobber each other's events (safeStatusWrite alone would rewrite a stale
  // snapshot after a 409).
  let lastLocal = null;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const localExisting = await readLocalJson(EVENTS_PATH, []);
    let existing = localExisting;
    let remoteSha;

    if (githubConfigured()) {
      try {
        const meta = await getRemoteFileMeta("events.json");
        remoteSha = meta?.sha;
        if (meta?.content) {
          existing = JSON.parse(Buffer.from(meta.content, "base64").toString("utf8"));
        }
      } catch (error) {
        console.warn(`Remote events read skipped: ${error.message}`);
      }
    }

    const events = [nextEvent, ...(Array.isArray(existing) ? existing : [])].slice(0, MAX_EVENTS);
    lastLocal = events;
    await writeLocalJson(EVENTS_PATH, events);

    if (!githubConfigured()) return;

    try {
      await writeRemoteJson("events.json", events, { sha: remoteSha || null });
      return;
    } catch (error) {
      const retryable = error.status === 409 || error.status === 502 || error.status === 503;
      if (!retryable || attempt === WRITE_ATTEMPTS) {
        console.warn(`Remote events write skipped: ${error.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  if (lastLocal) await writeLocalJson(EVENTS_PATH, lastLocal);
}

function pruneDailyStats(stats, today = londonDate()) {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - DAILY_STATS_RETENTION_DAYS);

  return Object.fromEntries(
    Object.entries(stats).filter(([day]) => {
      const parsed = new Date(`${day}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed >= cutoff;
    })
  );
}

function applyCheckOutcome(stats, state, at = new Date()) {
  const day = londonDate(at);
  const next = { ...stats };
  const dayStats = {
    checksCompleted: 0,
    byState: {},
    ...(next[day] || {}),
  };
  dayStats.byState = { ...(dayStats.byState || {}) };
  dayStats.checksCompleted = Number(dayStats.checksCompleted || 0) + 1;
  dayStats.byState[state] = Number(dayStats.byState[state] || 0) + 1;
  dayStats.updatedAt = new Date(at).toISOString();
  next[day] = dayStats;
  return pruneDailyStats(next, day);
}

async function recordCheckOutcome(state, message) {
  if (!CHECK_OUTCOME_STATES.has(state)) {
    throw new Error(`Unsupported check outcome state: ${state}`);
  }

  await appendEvent({ state, message });

  const localStats = applyCheckOutcome(await readLocalJson(DAILY_STATS_PATH, {}), state);
  await writeLocalJson(DAILY_STATS_PATH, localStats);

  if (!githubConfigured()) return localStats;

  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    try {
      const meta = await getRemoteFileMeta("daily-stats.json");
      let remoteStats = {};
      if (meta?.content) {
        remoteStats = JSON.parse(Buffer.from(meta.content, "base64").toString("utf8"));
      } else {
        remoteStats = (await readRemoteJson("daily-stats.json", {})) || {};
      }
      const merged = applyCheckOutcome(remoteStats, state);
      await writeRemoteJson("daily-stats.json", merged, { sha: meta?.sha || null });
      return merged;
    } catch (error) {
      const retryable = error.status === 409 || error.status === 502 || error.status === 503;
      if (!retryable || attempt === WRITE_ATTEMPTS) {
        console.warn(`Remote daily-stats write skipped: ${error.message}`);
        return localStats;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  return localStats;
}

async function readDailyStats() {
  const local = await readLocalJson(DAILY_STATS_PATH, {});
  return (await readRemoteJson("daily-stats.json", local)) || local;
}

async function readControl() {
  const fallback = { enabled: true };
  const local = await readLocalJson(CONTROL_PATH, null);
  const remote = await readRemoteJson("control.json", local || fallback);
  return {
    enabled: remote?.enabled !== false,
    emailCode: remote?.emailCode,
    emailCodeUpdatedAt: remote?.emailCodeUpdatedAt,
    updatedAt: remote?.updatedAt,
    updatedBy: remote?.updatedBy,
    pauseReason: remote?.pauseReason,
  };
}

async function writeControl(partial) {
  const existing = await readControl();
  const next = sanitizeDeep({
    ...existing,
    ...partial,
    updatedAt: partial?.updatedAt || new Date().toISOString(),
  });
  await safeStatusWrite(CONTROL_PATH, next);
  return next;
}

module.exports = {
  EVENT_STATES,
  CHECK_OUTCOME_STATES,
  appendEvent,
  applyCheckOutcome,
  londonDate,
  readControl,
  readDailyStats,
  recordCheckOutcome,
  redactPii,
  writeControl,
  writeStatus,
};
