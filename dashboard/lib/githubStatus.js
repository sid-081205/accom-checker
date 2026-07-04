const REPO = process.env.GITHUB_STATUS_REPO || "sid-081205/accom-checker";
const BRANCH = process.env.GITHUB_STATUS_BRANCH || "status";
const DEFAULT_BRANCH = process.env.GITHUB_STATUS_DEFAULT_BRANCH || "master";

function statusToken({ write = false } = {}) {
  return write
    ? process.env.GITHUB_STATUS_WRITE_TOKEN || process.env.GITHUB_STATUS_TOKEN
    : process.env.GITHUB_STATUS_TOKEN;
}

async function githubRequest(filePath, options = {}) {
  const fallback = options.fallback;
  const token = statusToken({ write: options.write });
  if (!token) return fallback;

  const response = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${filePath}?ref=${BRANCH}`,
    {
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
      cache: "no-store",
      ...(options.fetchOptions || {}),
    }
  );

  if (response.status === 404) return fallback;
  if (!response.ok) {
    throw new Error(`GitHub status read failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function readJsonFile(filePath, fallback) {
  try {
    return await githubRequest(filePath, { fallback });
  } catch (error) {
    console.warn(error.message);
    return fallback;
  }
}

async function getFileSha(filePath) {
  const token = statusToken({ write: true });
  if (!token) return null;

  const response = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${filePath}?ref=${BRANCH}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    }
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub sha read failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return payload.sha;
}

async function githubApi(route, options = {}) {
  const token = statusToken({ write: options.write });
  if (!token) {
    throw new Error("GitHub status token is not configured.");
  }

  const response = await fetch(`https://api.github.com${route}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API failed: ${response.status} ${response.statusText}: ${text}`);
  }

  return response.json();
}

async function ensureStatusBranch() {
  const existing = await githubApi(`/repos/${REPO}/git/ref/heads/${BRANCH}`, { write: true });
  if (existing) return;

  const source = await githubApi(`/repos/${REPO}/git/ref/heads/${DEFAULT_BRANCH}`, { write: true });
  if (!source?.object?.sha) {
    throw new Error(`Could not resolve source branch ${DEFAULT_BRANCH}.`);
  }

  await githubApi(`/repos/${REPO}/git/refs`, {
    method: "POST",
    write: true,
    body: JSON.stringify({
      ref: `refs/heads/${BRANCH}`,
      sha: source.object.sha,
    }),
  });
}

export async function writeControl(control) {
  await writeJsonFile("control.json", control, "Update dashboard control [skip ci]");
}

async function writeJsonFile(filePath, value, message) {
  const token = statusToken({ write: true });
  if (!token) {
    throw new Error("GITHUB_STATUS_WRITE_TOKEN is not configured.");
  }

  await ensureStatusBranch();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const sha = await getFileSha(filePath);
    const response = await fetch(`https://api.github.com/repos/${REPO}/contents/${filePath}`, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        branch: BRANCH,
        message,
        content: Buffer.from(JSON.stringify(value, null, 2)).toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    });

    if (response.ok) return;

    const text = await response.text();
    if (response.status !== 409 || attempt === 3) {
      throw new Error(`GitHub ${filePath} write failed: ${response.status} ${response.statusText}: ${text}`);
    }
  }
}

export async function writeDashboardStatus(status) {
  await writeJsonFile("status.json", status, "Update dashboard status [skip ci]");
}

export async function dispatchChecker() {
  const token = statusToken({ write: true });
  if (!token) return;

  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/check-availability.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "master" }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Workflow dispatch failed: ${response.status} ${response.statusText}: ${text}`);
  }
}

const CRONJOB_API_BASE = "https://api.cron-job.org";
const CRONJOB_CHECKER_JOB_ID = process.env.CRONJOB_CHECKER_JOB_ID || "7809757";

// Allowed checker cadences (minutes). Keep in sync with the dashboard toggle.
export const CHECKER_INTERVAL_OPTIONS = [2, 5];

async function cronjobRequest(route, options = {}) {
  const apiKey = process.env.CRONJOB_API_KEY;
  if (!apiKey) {
    throw new Error("CRONJOB_API_KEY is not configured; cannot manage the checker schedule.");
  }

  const response = await fetch(`${CRONJOB_API_BASE}${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `cron-job.org request failed: ${response.status} ${response.statusText}: ${text.slice(0, 300)}`
    );
  }

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`cron-job.org returned a non-JSON response: ${text.slice(0, 300)}`);
  }
}

export async function setCheckerCronEnabled(enabled) {
  await cronjobRequest(`/jobs/${CRONJOB_CHECKER_JOB_ID}`, {
    method: "PATCH",
    body: JSON.stringify({ job: { enabled: Boolean(enabled) } }),
  });
}

async function getCheckerCronJob() {
  const data = await cronjobRequest(`/jobs/${CRONJOB_CHECKER_JOB_ID}`);
  const job = data?.jobDetails;
  if (!job) {
    throw new Error(`cron-job.org job ${CRONJOB_CHECKER_JOB_ID} was not found.`);
  }
  return job;
}

// Derives the run interval in minutes from a cron-job.org schedule, or null if
// the schedule is not a uniform every-N-minutes pattern.
export function intervalFromSchedule(schedule) {
  const minutes = schedule?.minutes;
  if (!Array.isArray(minutes) || minutes.length === 0) return null;
  if (minutes.length === 1 && minutes[0] === -1) return 1;

  const sorted = [...new Set(minutes)].sort((a, b) => a - b);
  if (sorted.length < 2 || 60 % sorted.length !== 0) return null;

  const gap = 60 / sorted.length;
  const uniform = sorted.every((minute, index) => minute === sorted[0] + index * gap);
  return uniform && sorted[0] === 0 ? gap : null;
}

// Non-throwing read used by the dashboard page so a cron-job.org outage or a
// missing CRONJOB_API_KEY degrades the frequency card instead of crashing the page.
export async function getCheckerCronInfo() {
  try {
    const job = await getCheckerCronJob();
    return {
      available: true,
      enabled: job.enabled !== false,
      intervalMinutes: intervalFromSchedule(job.schedule),
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

export async function setCheckerCronInterval(intervalMinutes) {
  const interval = Number(intervalMinutes);
  if (!CHECKER_INTERVAL_OPTIONS.includes(interval)) {
    throw new Error(
      `Unsupported check interval "${intervalMinutes}". Allowed: ${CHECKER_INTERVAL_OPTIONS.join(", ")} minutes.`
    );
  }

  // cron-job.org replaces the whole schedule object on update, so read the
  // current job first and send the complete schedule back with only the
  // minutes changed. Fall back to the known job defaults for missing fields.
  const job = await getCheckerCronJob();
  const current = job.schedule || {};
  const minutes = Array.from({ length: 60 / interval }, (_, index) => index * interval);
  const schedule = {
    timezone: current.timezone || "Europe/London",
    expiresAt: current.expiresAt ?? 0,
    hours: Array.isArray(current.hours) && current.hours.length > 0 ? current.hours : [-1],
    mdays: Array.isArray(current.mdays) && current.mdays.length > 0 ? current.mdays : [-1],
    months: Array.isArray(current.months) && current.months.length > 0 ? current.months : [-1],
    wdays: Array.isArray(current.wdays) && current.wdays.length > 0 ? current.wdays : [-1],
    minutes,
  };

  await cronjobRequest(`/jobs/${CRONJOB_CHECKER_JOB_ID}`, {
    method: "PATCH",
    body: JSON.stringify({ job: { schedule } }),
  });

  // Read the job back to confirm cron-job.org actually applied the schedule.
  const updated = await getCheckerCronJob();
  const applied = intervalFromSchedule(updated.schedule);
  if (applied !== interval) {
    throw new Error(
      `cron-job.org accepted the update but the schedule reads every ${applied ?? "?"} min instead of every ${interval} min.`
    );
  }

  return interval;
}

export async function dispatchSummary() {
  const token = statusToken({ write: true });
  if (!token) return;

  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/daily-summary.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "master" }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Summary dispatch failed: ${response.status} ${response.statusText}: ${text}`);
  }
}

export async function getRecentCheckRuns(perPage = 10) {
  const token = statusToken();
  if (!token) return [];

  const data = await githubApi(
    `/repos/${REPO}/actions/workflows/check-availability.yml/runs?per_page=${perPage}`
  );
  return data?.workflow_runs || [];
}

export async function getStatus() {
  return readJsonFile("status.json", null);
}

export async function getEvents() {
  return readJsonFile("events.json", []);
}

export async function getControl() {
  const control = await readJsonFile("control.json", { enabled: true });
  return {
    enabled: control?.enabled !== false,
    updatedAt: control?.updatedAt,
    updatedBy: control?.updatedBy,
  };
}
