const assert = require("assert");
const {
  buildHealthLine,
  buildSummaryText,
  summarizeWorkflowRuns,
} = require("../src/summary");
const { applyCheckOutcome, londonDate } = require("../src/status");

function testSummarizeWorkflowRuns() {
  const summary = summarizeWorkflowRuns([
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "cancelled" },
    { status: "completed", conclusion: "cancelled" },
    { status: "in_progress", conclusion: null },
  ]);

  assert.strictEqual(summary.started, 6);
  assert.strictEqual(summary.completed, 5);
  assert.strictEqual(summary.succeeded, 2);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.cancelled, 2);
  assert.strictEqual(summary.inProgress, 1);
}

function testBuildSummaryTextMatchesJuly13Shape() {
  const workflow = summarizeWorkflowRuns([
    ...Array.from({ length: 104 }, () => ({ status: "completed", conclusion: "success" })),
    { status: "completed", conclusion: "failure" },
    ...Array.from({ length: 610 }, () => ({ status: "completed", conclusion: "cancelled" })),
    ...Array.from({ length: 3 }, () => ({ status: "in_progress", conclusion: null })),
  ]);

  const text = buildSummaryText({
    today: "2026-07-13",
    status: {
      state: "ok",
      message: "Checker ran successfully. No residences currently have availability.",
      workflowUrl: "https://github.com/example/actions/runs/1",
    },
    todaysEvents: Array.from({ length: 104 }, () => ({ state: "ok", at: "2026-07-13T12:00:00Z" })),
    workflow,
    dayStats: {
      checksCompleted: 104,
      byState: { ok: 104 },
    },
  });

  assert.match(text, /started: 718/);
  assert.match(text, /succeeded \(job ran\): 104/);
  assert.match(text, /failed: 1/);
  assert.match(text, /cancelled \(superseded \/ never ran\): 610/);
  assert.match(text, /completed: 104/);
  assert.match(text, /no availability: 104/);
  assert.match(text, /Health: DEGRADED/);
  assert.match(text, /Latest workflow: https:\/\/github.com\/example\/actions\/runs\/1/);

  // Started should equal succeeded + failed + cancelled + in progress.
  assert.strictEqual(workflow.succeeded + workflow.failed + workflow.cancelled + workflow.inProgress, 718);
}

function testHealthySummary() {
  const workflow = summarizeWorkflowRuns(
    Array.from({ length: 30 }, () => ({ status: "completed", conclusion: "success" }))
  );
  const text = buildSummaryText({
    today: "2026-07-14",
    status: { state: "ok", message: "ok" },
    todaysEvents: [],
    workflow,
    dayStats: { checksCompleted: 30, byState: { ok: 30 } },
  });
  assert.match(text, /Health: OK — 30 availability checks completed/);
  assert.strictEqual(buildHealthLine(workflow, 30).startsWith("Health: OK"), true);
}

function testDailyStatsAccumulate() {
  const day = londonDate("2026-07-13T12:00:00Z");
  let stats = {};
  stats = applyCheckOutcome(stats, "ok", "2026-07-13T12:00:00Z");
  stats = applyCheckOutcome(stats, "ok", "2026-07-13T12:02:00Z");
  stats = applyCheckOutcome(stats, "availability_found", "2026-07-13T12:04:00Z");
  assert.strictEqual(stats[day].checksCompleted, 3);
  assert.strictEqual(stats[day].byState.ok, 2);
  assert.strictEqual(stats[day].byState.availability_found, 1);
}

function testFallbackToEventsWhenNoStats() {
  const workflow = summarizeWorkflowRuns([
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "success" },
  ]);
  const text = buildSummaryText({
    today: "2026-07-12",
    status: { state: "ok", message: "ok" },
    todaysEvents: [
      { state: "ok", at: "2026-07-12T10:00:00Z" },
      { state: "ok", at: "2026-07-12T11:00:00Z" },
      { state: "login_required", at: "2026-07-12T11:00:00Z" },
    ],
    workflow,
    dayStats: null,
  });
  assert.match(text, /Availability checks that actually scraped\n  completed: 2/);
  assert.match(text, /no availability: 2/);
}

testSummarizeWorkflowRuns();
testBuildSummaryTextMatchesJuly13Shape();
testHealthySummary();
testDailyStatsAccumulate();
testFallbackToEventsWhenNoStats();
console.log("All summary/status unit tests passed.");
