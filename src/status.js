const fs = require("fs/promises");
const path = require("path");

const STATUS_BRANCH = process.env.STATUS_BRANCH || "status";
const STATUS_PATH = ".state/status.json";
const EVENTS_PATH = ".state/events.json";
const CONTROL_PATH = ".state/control.json";
const MAX_EVENTS = 1000;

function githubConfigured() {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);
}

async function githubRequest(route, options = {}) {
  const response = await fetch(`https://api.github.com${route}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub status write failed: ${response.status} ${response.statusText}: ${text}`);
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

async function getRemoteFileSha(filePath) {
  if (!githubConfigured()) return null;

  const repo = process.env.GITHUB_REPOSITORY;
  const file = await githubRequest(
    `/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${STATUS_BRANCH}`
  );

  return file?.sha || null;
}

async function writeRemoteJson(filePath, value) {
  if (!githubConfigured()) return;

  await ensureStatusBranch();
  const repo = process.env.GITHUB_REPOSITORY;
  const content = Buffer.from(JSON.stringify(value, null, 2)).toString("base64");
  const sha = await getRemoteFileSha(filePath);

  await githubRequest(`/repos/${repo}/contents/${encodeURIComponent(filePath)}`, {
    method: "PUT",
    body: JSON.stringify({
      branch: STATUS_BRANCH,
      message: `Update ${filePath} [skip ci]`,
      content,
      ...(sha ? { sha } : {}),
    }),
  });
}

async function readRemoteJson(filePath, fallback) {
  if (!githubConfigured()) return fallback;

  const repo = process.env.GITHUB_REPOSITORY;
  const file = await githubRequest(
    `/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${STATUS_BRANCH}`,
    {
      headers: {
        Accept: "application/vnd.github.raw+json",
      },
    }
  );

  return file || fallback;
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

  try {
    await writeRemoteJson(path.basename(filePath), value);
  } catch (error) {
    console.warn(`Remote status write skipped: ${error.message}`);
  }
}

async function writeStatus(partial) {
  const now = new Date().toISOString();
  const status = {
    updatedAt: now,
    workflowUrl: workflowUrl(),
    ...partial,
  };

  await safeStatusWrite(STATUS_PATH, status);
}

async function appendEvent(event) {
  const nextEvent = {
    at: new Date().toISOString(),
    ...event,
  };
  const existing = await readLocalJson(EVENTS_PATH, []);
  const events = [nextEvent, ...existing].slice(0, MAX_EVENTS);

  await safeStatusWrite(EVENTS_PATH, events);
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
  };
}

module.exports = {
  appendEvent,
  readControl,
  writeStatus,
};
