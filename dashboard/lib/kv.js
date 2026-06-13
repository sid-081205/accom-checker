const STATUS_KEY = "accom-checker:status";
const EVENTS_KEY = "accom-checker:events";

async function kvCommand(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    return null;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`KV command failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export async function getStatus() {
  const payload = await kvCommand(["GET", STATUS_KEY]);
  if (!payload?.result) return null;

  try {
    return JSON.parse(payload.result);
  } catch {
    return null;
  }
}

export async function getEvents() {
  const payload = await kvCommand(["LRANGE", EVENTS_KEY, "0", "19"]);
  const events = payload?.result || [];

  return events
    .map((event) => {
      try {
        return JSON.parse(event);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
