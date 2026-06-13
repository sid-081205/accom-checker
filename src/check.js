require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const { chromium } = require("playwright");

const START_URL =
  "https://lsestudentaccommodation.lse.ac.uk/Pages/EN/Lander.aspx?wf=Hub";
const NO_AVAILABILITY_TEXT = "No residences currently have availability";
const AUTH_STATE_PATH = path.resolve(".auth/lse-storage-state.json");
const STATE_PATH = path.resolve(".state/last-result.json");

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  if (!(await exists(filePath))) return null;
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function clickIfVisible(page, locator, timeout = 5000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click();
    await page.waitForLoadState("domcontentloaded");
    return true;
  } catch {
    return false;
  }
}

async function reachAvailabilityPage(page) {
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes("Please login") || bodyText.includes("Login")) {
    throw new Error(
      "Not logged in. Run `npm run login`, complete LSE login, then run the checker again."
    );
  }

  await clickIfVisible(page, page.getByRole("link", { name: /continue booking/i }));

  const westminsterQuestion = page.getByText(
    /Would you like to book a room in urbanest Westminster Bridge/i
  );
  if (await westminsterQuestion.isVisible().catch(() => false)) {
    await page.getByLabel("No").check();
    await page.getByRole("button", { name: /continue/i }).click();
    await page.waitForLoadState("domcontentloaded");
  }

  if (await page.getByRole("button", { name: /confirm/i }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /confirm/i }).click();
    await page.waitForLoadState("domcontentloaded");
  }

  await page.getByText(/Select your room type/i).waitFor({ timeout: 15000 });
}

async function extractAvailability(page) {
  const bodyText = await page.locator("body").innerText();
  const rooms = await page.locator(".RoomRow").evaluateAll((rows) =>
    rows.map((row) => ({
      text: row.innerText.trim().replace(/\n{3,}/g, "\n\n"),
      data: { ...row.dataset },
    }))
  );

  return {
    checkedAt: new Date().toISOString(),
    url: page.url(),
    noAvailability: bodyText.includes(NO_AVAILABILITY_TEXT),
    rooms,
    pageSummary: bodyText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 80)
      .join("\n"),
  };
}

function fingerprint(result) {
  if (result.noAvailability) return "no-availability";
  if (result.rooms.length > 0) {
    return JSON.stringify(result.rooms.map((room) => ({ text: room.text, data: room.data })));
  }
  return `changed-page:${result.pageSummary}`;
}

function formatEmail(result) {
  const roomDetails =
    result.rooms.length > 0
      ? result.rooms
          .map((room, index) => {
            const dataLines = Object.entries(room.data)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n");
            return [`Room ${index + 1}`, room.text, dataLines].filter(Boolean).join("\n");
          })
          .join("\n\n---\n\n")
      : `The usual no-availability text disappeared, but no .RoomRow entries were found.\n\nVisible page summary:\n${result.pageSummary}`;

  return [
    "Possible LSE accommodation availability found.",
    "",
    `Checked at: ${result.checkedAt}`,
    `URL: ${result.url}`,
    "",
    roomDetails,
  ].join("\n");
}

async function sendEmail(result) {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_TO"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing email environment variables: ${missing.join(", ")}`);
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: process.env.EMAIL_TO,
    subject: "Possible LSE accommodation availability",
    text: formatEmail(result),
  });
}

async function main() {
  if (!(await exists(AUTH_STATE_PATH))) {
    throw new Error("Missing saved login. Run `npm run login` first.");
  }

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });
  const context = await browser.newContext({ storageState: AUTH_STATE_PATH });
  const page = await context.newPage();

  try {
    await reachAvailabilityPage(page);
    const result = await extractAvailability(page);
    const currentFingerprint = fingerprint(result);
    const previous = await readJson(STATE_PATH);

    await writeJson(STATE_PATH, {
      checkedAt: result.checkedAt,
      fingerprint: currentFingerprint,
      noAvailability: result.noAvailability,
      roomCount: result.rooms.length,
    });

    if (result.noAvailability) {
      console.log(`[${result.checkedAt}] No availability.`);
      return;
    }

    const alreadyAlerted =
      previous?.fingerprint === currentFingerprint && process.env.SEND_ON_EVERY_HIT !== "true";
    if (alreadyAlerted) {
      console.log(`[${result.checkedAt}] Availability signal unchanged; email skipped.`);
      return;
    }

    await sendEmail(result);
    console.log(`[${result.checkedAt}] Availability signal found; email sent.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
