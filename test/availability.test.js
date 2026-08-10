const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { hasNoAvailabilityBanner, NO_AVAILABILITY_TEXT } = require("../src/check");

const FIXTURE_PATH = path.resolve("test/fixtures/injected-availability.html");

function fingerprint(result) {
  if (result.noAvailability) return "no-availability";
  if (result.rooms.length > 0) {
    return JSON.stringify(result.rooms.map((room) => ({ text: room.text, data: room.data })));
  }
  return `changed-page:${result.pageSummary}`;
}

function detectFromTextAndRooms(text, rooms) {
  return {
    noAvailability: hasNoAvailabilityBanner(text),
    rooms,
    pageSummary: text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 80)
      .join("\n"),
  };
}

function testFixtureHasAvailabilityMarkers() {
  const html = fs.readFileSync(FIXTURE_PATH, "utf8");
  assert.ok(html.includes('class="RoomRow"'), "fixture must include RoomRow nodes");
  assert.ok(html.includes("Grote Street"));
  assert.ok(html.includes("Rosebery"));
  assert.ok(!html.includes(NO_AVAILABILITY_TEXT), "availability fixture must not include the empty banner");

  const roomCount = (html.match(/class="RoomRow"/g) || []).length;
  assert.strictEqual(roomCount, 2);
}

function testDetectorFlagsRoomsAsAvailability() {
  const result = detectFromTextAndRooms("Select your room type\nAvailable now", [
    { text: "Standard Single Room\nGrote Street", data: { hall: "Grote Street" } },
    { text: "Twin Room\nRosebery", data: { hall: "Rosebery" } },
  ]);

  assert.strictEqual(result.noAvailability, false);
  assert.strictEqual(result.rooms.length, 2);
  assert.notStrictEqual(fingerprint(result), "no-availability");
  assert.ok(fingerprint(result).includes("Grote Street"));
}

function testDetectorFlagsEmptyBanner() {
  const result = detectFromTextAndRooms(
    `Select your room type\n${NO_AVAILABILITY_TEXT}`,
    []
  );
  assert.strictEqual(result.noAvailability, true);
  assert.strictEqual(fingerprint(result), "no-availability");
}

function testDetectorFlagsBannerVariants() {
  const variants = [
    "No residence currently has availability",
    "No residences have availability",
    "Sorry — there are currently no residences with availability.",
    "Currently have no availability",
    "No residences currently available",
    "No availability at this time",
  ];

  for (const variant of variants) {
    assert.ok(
      hasNoAvailabilityBanner(`Select your room type\n${variant}`),
      `expected empty-state match for: ${variant}`
    );
  }

  assert.ok(!hasNoAvailabilityBanner("Select your room type\nRosebery Hall — 1 room left"));
}

function testMissingBannerWithoutRowsStillAlerts() {
  // Same as production: if the empty-state banner disappears but RoomRow is
  // absent, treat it as a changed page so an email can still fire.
  const result = detectFromTextAndRooms("Select your room type\nUnexpected content", []);
  assert.strictEqual(result.noAvailability, false);
  assert.ok(fingerprint(result).startsWith("changed-page:"));
}

testFixtureHasAvailabilityMarkers();
testDetectorFlagsRoomsAsAvailability();
testDetectorFlagsEmptyBanner();
testDetectorFlagsBannerVariants();
testMissingBannerWithoutRowsStillAlerts();
console.log("Availability detector unit tests passed.");
