require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const START_URL =
  "https://lsestudentaccommodation.lse.ac.uk/Pages/EN/Lander.aspx?wf=Hub";
const NO_AVAILABILITY_TEXT = "No residences currently have availability";
const AUTH_COOKIES_PATH = path.resolve(".auth/lse-cookies.json");
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

async function createDriver() {
  const options = new chrome.Options();
  if (process.env.HEADLESS !== "false") {
    options.addArguments("--headless=new");
  }
  options.addArguments("--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,1200");

  return new Builder().forBrowser("chrome").setChromeOptions(options).build();
}

async function bodyText(driver) {
  return driver.findElement(By.css("body")).getText();
}

async function loadCookies(driver) {
  await driver.get(START_URL);
  const cookies = await readJson(AUTH_COOKIES_PATH);
  for (const cookie of cookies) {
    const seleniumCookie = { ...cookie };
    if (seleniumCookie.expiry && seleniumCookie.expiry < Math.floor(Date.now() / 1000)) {
      continue;
    }
    await driver.manage().addCookie(seleniumCookie);
  }
}

async function clickIfVisible(driver, locator, timeout = 5000) {
  try {
    const element = await driver.wait(until.elementLocated(locator), timeout);
    await driver.wait(until.elementIsVisible(element), timeout);
    await element.click();
    await driver.sleep(1000);
    return true;
  } catch {
    return false;
  }
}

async function chooseWestminsterNo(driver) {
  await driver.executeScript(() => {
    const labels = [...document.querySelectorAll("label")];
    const noLabel = labels.find((label) => label.textContent.trim() === "No");
    if (!noLabel) return;

    const input =
      noLabel.control ||
      noLabel.previousElementSibling ||
      document.getElementById(noLabel.getAttribute("for"));
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("click", { bubbles: true }));
    }
  });
}

async function reachAvailabilityPage(driver) {
  await driver.get(START_URL);

  let text = await bodyText(driver);
  if (text.includes("Please login") || text.includes("Login")) {
    throw new Error(
      "Not logged in. Run `npm run login`, complete LSE login, then run the checker again."
    );
  }

  await clickIfVisible(
    driver,
    By.xpath("//a[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'continue booking')]")
  );

  text = await bodyText(driver);
  if (text.includes("Would you like to book a room in urbanest Westminster Bridge")) {
    await chooseWestminsterNo(driver);
    await clickIfVisible(
      driver,
      By.xpath("//button[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'continue')]")
    );
  }

  text = await bodyText(driver);
  if (text.includes("About You")) {
    await clickIfVisible(
      driver,
      By.xpath("//button[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'confirm')]")
    );
  }

  await driver.wait(async () => (await bodyText(driver)).includes("Select your room type"), 15000);
}

async function extractAvailability(driver) {
  const text = await bodyText(driver);
  const rooms = await driver.executeScript(() =>
    [...document.querySelectorAll(".RoomRow")].map((row) => ({
      text: row.innerText.trim().replace(/\n{3,}/g, "\n\n"),
      data: { ...row.dataset },
    }))
  );

  return {
    checkedAt: new Date().toISOString(),
    url: await driver.getCurrentUrl(),
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
  if (!(await exists(AUTH_COOKIES_PATH))) {
    throw new Error("Missing saved login. Run `npm run login` first.");
  }

  const driver = await createDriver();

  try {
    await loadCookies(driver);
    await reachAvailabilityPage(driver);
    const result = await extractAvailability(driver);
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
    await driver.quit();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
