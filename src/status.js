const STATUS_KEY = "accom-checker:status";
const EVENTS_KEY = "accom-checker:events";

function kvConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvCommand(command) {
  if (!kvConfigured()) return null;

  const response = await fetch(process.env.KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    throw new Error(`KV command failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function workflowUrl() {
  if (!process.env.GITHUB_SERVER_URL || !process.env.GITHUB_REPOSITORY || !process.env.GITHUB_RUN_ID) {
    return undefined;
  }

  return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}

async function safeStatusWrite(command) {
  try {
    await kvCommand(command);
  } catch (error) {
    console.warn(`Status write skipped: ${error.message}`);
  }
}

async function writeStatus(partial) {
  const now = new Date().toISOString();
  const status = {
    updatedAt: now,
    workflowUrl: workflowUrl(),
    ...partial,
  };

  await safeStatusWrite(["SET", STATUS_KEY, JSON.stringify(status)]);
}

async function appendEvent(event) {
  const payload = JSON.stringify({
    at: new Date().toISOString(),
    ...event,
  });

  await safeStatusWrite(["LPUSH", EVENTS_KEY, payload]);
  await safeStatusWrite(["LTRIM", EVENTS_KEY, "0", "49"]);
}

module.exports = {
  appendEvent,
  writeStatus,
};
