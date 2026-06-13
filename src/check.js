require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { appendEvent, writeStatus } = require("./status");

const START_URL =
  "https://lsestudentaccommodation.lse.ac.uk/Pages/EN/Lander.aspx?wf=Hub";
const NO_AVAILABILITY_TEXT = "No residences currently have availability";
const AUTH_COOKIES_PATH = path.resolve(".auth/lse-cookies.json");
const STATE_PATH = path.resolve(".state/last-result.json");
const MFA_WAIT_MS = Number(process.env.MFA_WAIT_MS || 240000);

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

async function saveCookies(driver) {
  const cookies = await driver.manage().getCookies();
  await writeJson(AUTH_COOKIES_PATH, cookies);
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
  if (!(await exists(AUTH_COOKIES_PATH))) return false;

  const cookies = await readJson(AUTH_COOKIES_PATH);
  for (const cookie of cookies) {
    const seleniumCookie = { ...cookie };
    if (seleniumCookie.expiry && seleniumCookie.expiry < Math.floor(Date.now() / 1000)) {
      continue;
    }
    await driver.manage().addCookie(seleniumCookie);
  }
  return true;
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

async function typeIfPresent(driver, locator, value, timeout = 10000) {
  const element = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(element), timeout);
  await element.clear().catch(() => {});
  await element.sendKeys(value);
  return element;
}

async function clickButtonByText(driver, text, timeout = 10000) {
  const lower = text.toLowerCase();
  return clickIfVisible(
    driver,
    By.xpath(
      `//*[self::button or self::input or self::a][contains(translate(normalize-space(@value), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lower}') or contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lower}')]`
    ),
    timeout
  );
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

async function accommodationLoginVisible(driver) {
  const text = await bodyText(driver);
  return text.includes("Please login") || text.includes("Login");
}

async function loggedInAccommodationVisible(driver) {
  const text = await bodyText(driver);
  return (
    text.includes("Select your Year of Stay") ||
    text.includes("Continue Booking") ||
    text.includes("Select your room type") ||
    text.includes("Available Rooms")
  );
}

async function extractMfaCode(driver) {
  return driver.executeScript(() => {
    const selectors = [
      "[id*='displaySign']",
      "[id*='DisplaySign']",
      "[data-testid*='display']",
      "[class*='displaySign']",
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const match = element?.innerText?.match(/\b\d{2,3}\b/);
      if (match) return match[0];
    }

    const visibleText = document.body.innerText || "";
    const lines = visibleText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const numberLine = lines.find((line) => /^\d{2,3}$/.test(line));
    if (numberLine) return numberLine;

    const nearby = visibleText.match(/(?:number|code)[^\d]*(\d{2,3})/i);
    return nearby?.[1] || null;
  });
}

async function waitForMfaApproval(driver, code) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MFA_WAIT_MS) {
    if (await loggedInAccommodationVisible(driver).catch(() => false)) {
      return;
    }

    await clickButtonByText(driver, "yes", 1000).catch(() => false);
    await driver.sleep(3000);
  }

  throw new Error(`Timed out waiting for Microsoft Authenticator approval for code ${code}.`);
}

async function automateLogin(driver) {
  const email = process.env.LSE_EMAIL;
  const password = process.env.LSE_PASSWORD;
  if (!email || !password) {
    throw new Error("LSE_EMAIL and LSE_PASSWORD are required to refresh an expired login.");
  }

  await writeStatus({
    state: "login_required",
    message: "Saved LSE session is missing or expired; starting automated login.",
  });
  await appendEvent({
    state: "login_required",
    message: "Saved LSE session is missing or expired; starting automated login.",
  });

  await driver.get(START_URL);
  await clickButtonByText(driver, "login", 8000).catch(() => false);

  await typeIfPresent(
    driver,
    By.css("input[type='email'], input[name='loginfmt'], input#i0116"),
    email
  );
  await clickButtonByText(driver, "next");

  await typeIfPresent(
    driver,
    By.css("input[type='password'], input[name='passwd'], input#i0118"),
    password
  );
  await clickButtonByText(driver, "sign in");

  const code = await driver.wait(async () => extractMfaCode(driver), 30000);
  const message = `Microsoft Authenticator approval required. Enter/approve number ${code}.`;
  await writeStatus({
    state: "needs_mfa",
    message,
    mfaCode: code,
  });
  await appendEvent({
    state: "needs_mfa",
    message,
  });
  await sendOperationalEmail("LSE accommodation checker needs Authenticator approval", message);

  await waitForMfaApproval(driver, code);
  await clickButtonByText(driver, "yes", 5000).catch(() => false);
  await driver.wait(async () => loggedInAccommodationVisible(driver), 60000);
  await saveCookies(driver);

  await writeStatus({
    state: "running",
    message: "LSE login refreshed successfully; continuing availability check.",
  });
  await appendEvent({
    state: "running",
    message: "LSE login refreshed successfully.",
  });
}

async function reachAvailabilityPage(driver) {
  await driver.get(START_URL);

  let text = await bodyText(driver);
  if (await accommodationLoginVisible(driver)) {
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

async function sendAvailabilityEmail(result) {
  await sendMail("Possible LSE accommodation availability", formatAvailabilityEmail(result));
}

async function sendOperationalEmail(subject, text) {
  await sendMail(subject, text);
}

async function main() {
  const driver = await createDriver();

  try {
    await writeStatus({
      state: "starting",
      message: "GitHub Actions checker run started.",
    });

    await loadCookies(driver);
    try {
      await reachAvailabilityPage(driver);
    } catch (error) {
      if (!error.message.includes("Not logged in")) throw error;
      await automateLogin(driver);
      await reachAvailabilityPage(driver);
    }

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
      await writeStatus({
        state: "ok",
        message: "Checker ran successfully. No residences currently have availability.",
        checkedAt: result.checkedAt,
        noAvailability: true,
        roomCount: result.rooms.length,
        summary: result.pageSummary,
      });
      await appendEvent({
        state: "ok",
        message: "No availability found.",
      });
      console.log(`[${result.checkedAt}] No availability.`);
      return;
    }

    const alreadyAlerted =
      previous?.fingerprint === currentFingerprint && process.env.SEND_ON_EVERY_HIT !== "true";
    if (alreadyAlerted) {
      await writeStatus({
        state: "availability_found",
        message: "Availability signal is still present; duplicate email skipped.",
        checkedAt: result.checkedAt,
        noAvailability: false,
        roomCount: result.rooms.length,
        summary: result.pageSummary,
      });
      console.log(`[${result.checkedAt}] Availability signal unchanged; email skipped.`);
      return;
    }

    await sendAvailabilityEmail(result);
    await writeStatus({
      state: "availability_found",
      message: "Availability signal found and email sent.",
      checkedAt: result.checkedAt,
      noAvailability: false,
      roomCount: result.rooms.length,
      summary: result.pageSummary,
    });
    await appendEvent({
      state: "availability_found",
      message: "Availability signal found and email sent.",
    });
    console.log(`[${result.checkedAt}] Availability signal found; email sent.`);
  } finally {
    await driver.quit();
  }
}

main().catch(async (error) => {
  await writeStatus({
    state: error.message.includes("LSE_EMAIL") ? "login_failed" : "error",
    message: error.message,
    error: error.stack || error.message,
  });
  await appendEvent({
    state: error.message.includes("LSE_EMAIL") ? "login_failed" : "error",
    message: error.message,
  });
  console.error(error.message);
  process.exitCode = 1;
});
