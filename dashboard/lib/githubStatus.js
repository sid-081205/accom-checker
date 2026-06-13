const REPO = process.env.GITHUB_STATUS_REPO || "sid-081205/accom-checker";
const BRANCH = process.env.GITHUB_STATUS_BRANCH || "status";

async function readJsonFile(filePath, fallback) {
  const token = process.env.GITHUB_STATUS_TOKEN;
  if (!token) return fallback;

  const response = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${filePath}?ref=${BRANCH}`,
    {
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    }
  );

  if (response.status === 404) return fallback;
  if (!response.ok) {
    throw new Error(`GitHub status read failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export async function getStatus() {
  return readJsonFile("status.json", null);
}

export async function getEvents() {
  return readJsonFile("events.json", []);
}
