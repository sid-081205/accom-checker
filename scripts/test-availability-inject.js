require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const { hasNoAvailabilityBanner } = require("../src/check");

const FIXTURE_PATH = path.resolve("test/fixtures/injected-availability.html");

async function bodyText(driver) {
  const body = await driver.wait(until.elementLocated(By.css("body")), 10000);
  return body.getText();
}

async function extractAvailability(driver, checkedAt) {
  const text = await bodyText(driver);
  const rooms = await driver.executeScript(() =>
    [...document.querySelectorAll(".RoomRow")].map((row) => ({
      text: row.innerText.trim().replace(/\n{3,}/g, "\n\n"),
      data: { ...row.dataset },
    }))
  );

  return {
    checkedAt,
    url: await driver.getCurrentUrl(),
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

function formatAvailabilityEmail(result) {
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
    "",
    "[TEST] This email was sent by scripts/test-availability-inject.js using injected HTML.",
  ].join("\n");
}

async function sendMail(subject, text) {
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
    subject,
    text,
  });
}

async function main() {
  await fs.access(FIXTURE_PATH);

  const options = new chrome.Options();
  options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,1200");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    const fixtureUrl = `file://${FIXTURE_PATH}`;
    await driver.get(fixtureUrl);

    const result = await extractAvailability(driver, new Date().toISOString());

    console.log(
      `Detector result: noAvailability=${result.noAvailability}, roomCount=${result.rooms.length}`
    );

    if (result.noAvailability) {
      throw new Error("Detector incorrectly reported no availability on injected fixture.");
    }
    if (result.rooms.length === 0) {
      throw new Error("Detector found no .RoomRow entries on injected fixture.");
    }

    if (process.env.SEND_TEST_AVAILABILITY_EMAIL === "true") {
      await sendMail(
        "[TEST] Possible LSE accommodation availability",
        formatAvailabilityEmail(result)
      );
      console.log("Sent test availability email.");
    } else {
      console.log("Dry run only (set SEND_TEST_AVAILABILITY_EMAIL=true to send email).");
    }
  } finally {
    await driver.quit();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
