require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { appendEvent, readControl, recordCheckOutcome, redactPii, writeStatus } = require("./status");

const START_URL =
  "https://lsestudentaccommodation.lse.ac.uk/Pages/EN/Lander.aspx?wf=Hub";
const NO_AVAILABILITY_TEXT = "No residences currently have availability";
const AUTH_COOKIES_PATH = path.resolve(".auth/lse-cookies.json");
const CHROME_PROFILE_DIR = path.resolve(".auth/chrome-profile");
const STATE_PATH = path.resolve(".state/last-result.json");
const MFA_WAIT_MS = Number(process.env.MFA_WAIT_MS || 240000);
const CHECK_ATTEMPTS = Number(process.env.CHECK_ATTEMPTS || 3);

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
  await fs.mkdir(CHROME_PROFILE_DIR, { recursive: true });
  const options = new chrome.Options();
  if (process.env.HEADLESS !== "false") {
    options.addArguments("--headless=new");
  }
  options.addArguments(
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--window-size=1440,1200",
    `--user-data-dir=${CHROME_PROFILE_DIR}`
  );

  return new Builder().forBrowser("chrome").setChromeOptions(options).build();
}

async function bodyText(driver) {
  const body = await driver.wait(until.elementLocated(By.css("body")), 20000);
  return body.getText();
}

async function pageDebug(driver) {
  const text = await bodyText(driver).catch(() => "");
  return {
    url: await driver.getCurrentUrl().catch(() => "unknown"),
    title: await driver.getTitle().catch(() => "unknown"),
    text: text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 25)
      .join(" | "),
  };
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
    await driver.executeScript("arguments[0].scrollIntoView({ block: 'center' });", element);
    await driver.sleep(250);
    try {
      await element.click();
    } catch {
      await driver.executeScript("arguments[0].click();", element);
    }
    await driver.sleep(1000);
    return true;
  } catch {
    return false;
  }
}

async function typeIfPresent(driver, locator, value, timeout = 10000) {
  let element;
  try {
    element = await driver.wait(until.elementLocated(locator), timeout);
  } catch (error) {
    const debug = await pageDebug(driver);
    throw new Error(
      `Timed out waiting for input ${locator}. URL: ${debug.url}. Title: ${debug.title}. Visible text: ${debug.text}`
    );
  }
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
  return driver.executeScript(() => {
    const labels = [...document.querySelectorAll("label")];
    const noLabel = labels.find((label) => label.textContent.trim() === "No");
    if (!noLabel) return false;

    const input =
      noLabel.control ||
      noLabel.previousElementSibling ||
      document.getElementById(noLabel.getAttribute("for"));
    if (input) {
      input.scrollIntoView({ block: "center" });
      input.click();
      if ("checked" in input) input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    noLabel.scrollIntoView({ block: "center" });
    noLabel.click();
    return true;
  });
}

async function continueFromWestminsterQuestion(driver) {
  const selected = await chooseWestminsterNo(driver);
  if (!selected) {
    throw new Error("Could not select No on the Westminster Bridge question.");
  }

  await driver.sleep(500);
  const continued = await driver.executeScript(() => {
    const candidates = [
      ...document.querySelectorAll("input[type='submit'], button, a"),
    ];
    const control = candidates.find((candidate) => {
      const text = `${candidate.value || ""} ${candidate.innerText || ""}`.trim().toLowerCase();
      return text.includes("continue");
    });

    if (!control) return false;
    control.scrollIntoView({ block: "center" });
    control.click();
    return true;
  });

  if (!continued) {
    throw new Error("Could not click Continue on the Westminster Bridge question.");
  }

  await driver.sleep(2000);
}

async function accommodationLoginVisible(driver) {
  // Prefer positive logged-in signals first. Matching bare "Login" is too broad —
  // the lander nav often contains a Login link even when the session is valid,
  // which forced a full login dance on every check and bloated run time/events.
  if (await loggedInAccommodationVisible(driver).catch(() => false)) {
    return false;
  }

  const text = await bodyText(driver);
  return /please\s+login/i.test(text);
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

async function waitForDashboardEmailCode(promptedAt) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MFA_WAIT_MS) {
    const control = await readControl();
    const codeUpdatedAt = control.emailCodeUpdatedAt ? new Date(control.emailCodeUpdatedAt).getTime() : 0;
    if (control.emailCode && codeUpdatedAt >= promptedAt) {
      return control.emailCode.trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error("Timed out waiting for email verification code from the dashboard.");
}

async function submitEmailCode(driver, code) {
  const input = await driver.wait(
    until.elementLocated(
      By.css("input[name='otc'], input#idTxtBx_SAOTCC_OTC, input[type='tel'], input[type='text']")
    ),
    30000
  );
  await driver.wait(until.elementIsVisible(input), 10000);
  await input.clear().catch(() => {});
  await input.sendKeys(code);
  await clickButtonByText(driver, "verify", 5000).catch(() => false);
  await clickButtonByText(driver, "next", 5000).catch(() => false);
  await clickButtonByText(driver, "submit", 5000).catch(() => false);
  await driver.sleep(3000);
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

  await driver.get(START_URL);
  await clickButtonByText(driver, "login", 8000).catch(() => false);
  if (await loggedInAccommodationVisible(driver).catch(() => false)) {
    await saveCookies(driver);
    await writeStatus({
      state: "running",
      message: "LSE session is already active; continuing availability check.",
    });
    return;
  }

  const clickedStaff = await clickIfVisible(driver, By.css("#staff"), 8000);
  if (await loggedInAccommodationVisible(driver).catch(() => false)) {
    await saveCookies(driver);
    await writeStatus({
      state: "running",
      message: "LSE session is already active after identity selection; continuing availability check.",
    });
    return;
  }

  if (!clickedStaff && !(await driver.getCurrentUrl()).includes("login.microsoftonline.com")) {
    const debug = await pageDebug(driver);
    throw new Error(
      `Could not reach Microsoft sign-in from LSE identity page. URL: ${debug.url}. Title: ${debug.title}. Visible text: ${debug.text}`
    );
  }

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

  const authText = await bodyText(driver);
  if (/email|verification code|enter code|security code/i.test(authText)) {
    const promptedAt = Date.now();
    const message =
      "LSE/Microsoft login is asking for an email verification code. Enter it on the dashboard while this run is waiting.";
    await writeStatus({
      state: "needs_email_code",
      message,
    });
    await appendEvent({
      state: "needs_email_code",
      message,
    });
    await sendOperationalEmail("LSE accommodation checker needs email verification", message);
    const emailCode = await waitForDashboardEmailCode(promptedAt);
    await submitEmailCode(driver, emailCode);
    await clickButtonByText(driver, "yes", 5000).catch(() => false);
    const loggedInAfterEmailCode = await driver
      .wait(async () => loggedInAccommodationVisible(driver), 15000)
      .catch(() => false);
    if (loggedInAfterEmailCode) {
      await saveCookies(driver);
      await writeStatus({
        state: "running",
        message: "LSE login refreshed successfully with email verification; continuing availability check.",
      });
      return;
    }
  }

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
    await continueFromWestminsterQuestion(driver);
  }

  text = await bodyText(driver);
  if (text.includes("About You")) {
    const confirmed = await clickButtonByText(driver, "confirm", 8000);
    if (!confirmed) {
      throw new Error("Could not click Confirm on the About You page.");
    }
  }

  try {
    await driver.wait(async () => (await bodyText(driver)).includes("Select your room type"), 15000);
  } catch (error) {
    const debug = await pageDebug(driver);
    throw new Error(
      `Timed out waiting for availability page. URL: ${debug.url}. Title: ${debug.title}. Visible text: ${debug.text}`
    );
  }
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

const MAIL_SEND_ATTEMPTS = Number(process.env.MAIL_SEND_ATTEMPTS || 3);

async function sendMail(subject, text) {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_TO"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing email environment variables: ${missing.join(", ")}`);
  }

  let lastError;
  for (let attempt = 1; attempt <= MAIL_SEND_ATTEMPTS; attempt += 1) {
    // Fresh transporter per attempt so a broken connection is not reused.
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.SMTP_USER,
        to: process.env.EMAIL_TO,
        subject,
        text,
      });
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `Email send attempt ${attempt}/${MAIL_SEND_ATTEMPTS} failed: ${redactPii(error.message)}`
      );
      if (attempt < MAIL_SEND_ATTEMPTS) {
        await sleep(2000 * attempt);
      }
    } finally {
      transporter.close();
    }
  }

  throw new Error(
    `Email send failed after ${MAIL_SEND_ATTEMPTS} attempts: ${lastError?.message || "unknown error"}`
  );
}

async function sendAvailabilityEmail(result) {
  await sendMail("Possible LSE accommodation availability", formatAvailabilityEmail(result));
}

async function sendOperationalEmail(subject, text) {
  await sendMail(subject, text);
}

async function performCheckAttempt(attempt) {
  const driver = await createDriver();

  try {
    await writeStatus({
      state: "starting",
      message: `GitHub Actions checker run started. Attempt ${attempt}/${CHECK_ATTEMPTS}.`,
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
    const persistState = () =>
      writeJson(STATE_PATH, {
        checkedAt: result.checkedAt,
        fingerprint: currentFingerprint,
        noAvailability: result.noAvailability,
        roomCount: result.rooms.length,
      });

    if (result.noAvailability) {
      await persistState();
      await writeStatus({
        state: "ok",
        message: "Checker ran successfully. No residences currently have availability.",
        checkedAt: result.checkedAt,
        noAvailability: true,
        roomCount: result.rooms.length,
        summary: result.pageSummary,
      });
      await recordCheckOutcome("ok", "No availability found.");
      console.log(`[${result.checkedAt}] No availability.`);
      return;
    }

    const alreadyAlerted =
      previous?.fingerprint === currentFingerprint && process.env.SEND_ON_EVERY_HIT !== "true";
    if (alreadyAlerted) {
      await persistState();
      await writeStatus({
        state: "availability_found",
        message: "Availability signal is still present; duplicate email skipped.",
        checkedAt: result.checkedAt,
        noAvailability: false,
        roomCount: result.rooms.length,
        summary: result.pageSummary,
      });
      await recordCheckOutcome(
        "availability_found",
        "Availability signal is still present; duplicate email skipped."
      );
      console.log(`[${result.checkedAt}] Availability signal unchanged; email skipped.`);
      return;
    }

    await sendAvailabilityEmail(result);
    // Persist the fingerprint only after the email is confirmed sent. If the
    // send fails, the next run must not treat this availability as already
    // alerted, or the one alert that matters would be skipped forever.
    await persistState();
    await writeStatus({
      state: "availability_found",
      message: "Availability signal found and email sent.",
      checkedAt: result.checkedAt,
      noAvailability: false,
      roomCount: result.rooms.length,
      summary: result.pageSummary,
    });
    await recordCheckOutcome("availability_found", "Availability signal found and email sent.");
    console.log(`[${result.checkedAt}] Availability signal found; email sent.`);
  } finally {
    await driver.quit();
  }
}

function isRetryableError(error) {
  const message = `${error?.message || ""}\n${error?.stack || ""}`;
  return [
    "no such element",
    "stale element",
    "timeout",
    "timed out",
    "chrome not reachable",
    "target window already closed",
    "net::",
    "detached",
    "email send failed",
  ].some((needle) => message.toLowerCase().includes(needle));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const control = await readControl();
  if (!control.enabled) {
    const message = "Checker is paused from the dashboard.";
    await writeStatus({
      state: "paused",
      message,
      control,
    });
    await appendEvent({
      state: "paused",
      message,
    });
    console.log(message);
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= CHECK_ATTEMPTS; attempt += 1) {
    try {
      await performCheckAttempt(attempt);
      return;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      if (!retryable || attempt === CHECK_ATTEMPTS) {
        throw error;
      }

      const message = `Attempt ${attempt}/${CHECK_ATTEMPTS} failed with a retryable browser/page error; retrying with a fresh browser. ${error.message}`;
      console.warn(redactPii(message));
      await writeStatus({
        state: "retrying",
        message,
        error: error.stack || error.message,
      });
      await sleep(5000 * attempt);
    }
  }

  throw lastError;
}

main().catch(async (error) => {
  const state = error.message.includes("LSE_EMAIL") ? "login_failed" : "error";
  await writeStatus({
    state,
    message: error.message,
    error: error.stack || error.message,
  });
  await recordCheckOutcome(state, error.message);
  console.error(redactPii(error.message));
  process.exitCode = 1;
});
