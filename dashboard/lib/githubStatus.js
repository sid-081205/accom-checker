const REPO = process.env.GITHUB_STATUS_REPO || "sid-081205/accom-checker";
const BRANCH = process.env.GITHUB_STATUS_BRANCH || "status";

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
  return githubRequest(filePath, { fallback });
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

export async function writeControl(control) {
  const token = statusToken({ write: true });
  if (!token) {
    throw new Error("GITHUB_STATUS_WRITE_TOKEN is not configured.");
  }

  const sha = await getFileSha("control.json");
  const response = await fetch(`https://api.github.com/repos/${REPO}/contents/control.json`, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      branch: BRANCH,
      message: "Update dashboard control [skip ci]",
      content: Buffer.from(JSON.stringify(control, null, 2)).toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub control write failed: ${response.status} ${response.statusText}: ${text}`);
  }
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
