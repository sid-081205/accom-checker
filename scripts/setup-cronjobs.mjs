#!/usr/bin/env node
// Creates (or updates) the two cron-job.org jobs that drive the accom checker.
//
// These jobs call the GitHub REST API directly to dispatch the workflows
// (this is the active architecture - the Vercel dashboard is NOT in the path):
//   1. Checker       -> POST .../check-availability.yml/dispatches  every 5 minutes
//   2. Daily summary -> POST .../daily-summary.yml/dispatches       once a day
//
// Required env vars:
//   CRONJOB_API_KEY       API key from https://console.cron-job.org (Settings -> API)
//   GITHUB_DISPATCH_TOKEN GitHub PAT with `actions: write` on the repo
// Optional env vars:
//   GITHUB_REPO     owner/repo (default sid-081205/accom-checker)
//   GITHUB_REF      git ref to dispatch (default master)
//   SUMMARY_HOUR    Hour (Europe/London) to send the daily summary (default 23)
//   SUMMARY_MINUTE  Minute to send the daily summary (default 55)
//   TIMEZONE        Schedule timezone (default Europe/London)

const API_BASE = "https://api.cron-job.org";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const apiKey = requireEnv("CRONJOB_API_KEY");
const githubToken = requireEnv("GITHUB_DISPATCH_TOKEN");
const repo = process.env.GITHUB_REPO || "sid-081205/accom-checker";
const ref = process.env.GITHUB_REF || "master";
const timezone = process.env.TIMEZONE || "Europe/London";
const summaryHour = Number(process.env.SUMMARY_HOUR ?? 23);
const summaryMinute = Number(process.env.SUMMARY_MINUTE ?? 55);

const everyFiveMinutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

const githubHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${githubToken}`,
  "Content-Type": "application/json",
  "X-GitHub-Api-Version": "2022-11-28",
};

function dispatchUrl(workflowFile) {
  return `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;
}

const jobs = [
  {
    title: "Accom checker GitHub Actions dispatch",
    url: dispatchUrl("check-availability.yml"),
    schedule: {
      timezone,
      expiresAt: 0,
      hours: [-1],
      mdays: [-1],
      minutes: everyFiveMinutes,
      months: [-1],
      wdays: [-1],
    },
  },
  {
    title: "Accom daily summary GitHub Actions dispatch",
    url: dispatchUrl("daily-summary.yml"),
    schedule: {
      timezone,
      expiresAt: 0,
      hours: [summaryHour],
      mdays: [-1],
      minutes: [summaryMinute],
      months: [-1],
      wdays: [-1],
    },
  },
];

async function cronjobRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`cron-job.org ${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function listExistingJobs() {
  const data = await cronjobRequest("/jobs");
  return data?.jobs || [];
}

async function upsertJob(jobConfig, existingJobs) {
  const payload = {
    job: {
      url: jobConfig.url,
      enabled: true,
      title: jobConfig.title,
      saveResponses: true,
      requestMethod: 1, // POST
      requestTimeout: 30,
      schedule: jobConfig.schedule,
      extendedData: {
        headers: githubHeaders,
        body: JSON.stringify({ ref }),
      },
    },
  };

  const match = existingJobs.find(
    (job) => job.title === jobConfig.title || job.url === jobConfig.url
  );

  if (match) {
    await cronjobRequest(`/jobs/${match.jobId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    console.log(`Updated "${jobConfig.title}" (jobId ${match.jobId})`);
    return;
  }

  const created = await cronjobRequest("/jobs", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  console.log(`Created "${jobConfig.title}" (jobId ${created?.jobId})`);
}

async function main() {
  const existingJobs = await listExistingJobs();
  for (const jobConfig of jobs) {
    await upsertJob(jobConfig, existingJobs);
  }
  console.log("Done. Verify at https://console.cron-job.org/");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
