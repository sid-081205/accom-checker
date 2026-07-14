const assert = require("assert");
const fs = require("fs");
const path = require("path");

const NO_AVAILABILITY_TEXT = "No residences currently have availability";
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
    noAvailability: text.includes(NO_AVAILABILITY_TEXT),
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
testMissingBannerWithoutRowsStillAlerts();
console.log("Availability detector unit tests passed.");
