require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const {
  appendEvent,
  readControl,
  recordCheckOutcome,
  redactPii,
  writeControl,
  writeStatus,
} = require("./status");

const START_URL =
  "https://lsestudentaccommodation.lse.ac.uk/Pages/EN/Lander.aspx?wf=Hub";
const NO_AVAILABILITY_TEXT = "No residences currently have availability";
// Match the empty-state banner and common wording variants. If NONE of these
// match, treat the page as an availability signal and email.
const NO_AVAILABILITY_PATTERNS = [
  /no\s+residences?\s+currently\s+have\s+availability/i,
  /no\s+residences?\s+currently\s+has\s+availability/i,
  /no\s+residences?\s+have\s+availability/i,
  /no\s+residence\s+currently\s+has\s+availability/i,
  /currently\s+(have|has)\s+no\s+availability/i,
  /there\s+(are|is)\s+currently\s+no\s+(residences?\s+with\s+)?availability/i,
  /no\s+residences?\s+currently\s+available/i,
  /no\s+availability\s+at\s+(this|the)\s+(time|moment)/i,
];
const AUTH_COOKIES_PATH = path.resolve(".auth/lse-cookies.json");
const CHROME_PROFILE_DIR = path.resolve(".auth/chrome-profile");
const STATE_PATH = path.resolve(".state/last-result.json");
const MFA_WAIT_MS = Number(process.env.MFA_WAIT_MS || 240000);
const CHECK_ATTEMPTS = Number(process.env.CHECK_ATTEMPTS || 3);
const BODY_TEXT_ATTEMPTS = Number(process.env.BODY_TEXT_ATTEMPTS || 4);
const SITE_ERROR_RETRY_MS = Number(process.env.SITE_ERROR_RETRY_MS || 30000);
const LANDER_READY_MS = Number(process.env.LANDER_READY_MS || 45000);
const LSE_PORTAL_ERROR_PREFIX = "LSE portal unexpected error";
const SEND_ON_EVERY_HIT = process.env.SEND_ON_EVERY_HIT === "true";

function hasNoAvailabilityBanner(text = "") {
  const haystack = String(text || "");
  if (!haystack.trim()) return false;
  if (haystack.includes(NO_AVAILABILITY_TEXT)) return true;
  return NO_AVAILABILITY_PATTERNS.some((pattern) => pattern.test(haystack));
}

// Page navigations / ASP.NET postbacks invalidate DOM handles mid-read.
const TRANSIENT_PAGE_ERROR_NEEDLES = [
  "stale element",
  "no such execution context",
  "execution context was destroyed",
  "document was unloaded",
  "frame was detached",
  "detached",
  "node with given id does not belong",
  "aborted by navigation",
  "loader has changed",
];

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  return `${error?.name || ""}\n${error?.message || ""}\n${error?.stack || ""}`.toLowerCase();
}

function isTransientPageError(error) {
  const message = errorText(error);
  return TRANSIENT_PAGE_ERROR_NEEDLES.some((needle) => message.includes(needle));
}

function isTimeoutError(error) {
  return /timeout|timed out/.test(errorText(error));
}

function isLseUnexpectedErrorPage({ text = "", title = "" } = {}) {
  const haystack = `${title}\n${text}`.toLowerCase();
  return (
    haystack.includes("an error has occurred") ||
    haystack.includes("unexpected error") ||
    haystack.includes("please close your browser and retry")
  );
}

function isLanderLoading(text = "") {
  const haystack = String(text || "").toLowerCase();
  if (!haystack.trim()) return false;
  // Finished lander / booking pages are never "still loading".
  if (
    haystack.includes("select your year of stay") ||
    haystack.includes("continue booking") ||
    haystack.includes("select your room type") ||
    haystack.includes("available rooms") ||
    haystack.includes("please login")
  ) {
    return false;
  }
  return (
    haystack.includes("validating and loading your details") ||
    haystack.includes("loading your details") ||
    (haystack.includes("loading...") && haystack.includes("please wait"))
  );
}

function isAccommodationAppCookie(cookie = {}) {
  const domain = String(cookie.domain || "")
    .replace(/^\./, "")
    .toLowerCase();
  const name = String(cookie.name || "");
  // Accommodation ASP.NET session is poisoned by concurrent browsers.
  // LSE IdP/Shibboleth cookies also go stale and produce "Stale Request".
  if (domain.includes("lsestudentaccommodation.lse.ac.uk")) return true;
  if (domain.includes("gate.library.lse.ac.uk") || domain.includes("idp.lse.ac.uk")) {
    return true;
  }
  return /asp\.net_sessionid|__requestverificationtoken|shib_idp_session|jsessionid/i.test(
    name
  );
}

function isMicrosoftSsoCookie(cookie = {}) {
  const domain = String(cookie.domain || "")
    .replace(/^\./, "")
    .toLowerCase();
  return (
    domain.includes("microsoftonline.com") ||
    domain.includes("microsoftazuread-sso.com") ||
    domain.includes("microsoft.com") ||
    domain.includes("live.com") ||
    domain.includes("msauth.net") ||
    domain.includes("msftauth.net")
  );
}

function isStaleIdpRequestPage({ text = "", title = "", url = "" } = {}) {
  const haystack = `${title}\n${text}\n${url}`.toLowerCase();
  return (
    haystack.includes("stale request") ||
    haystack.includes("web login service - stale request") ||
    (haystack.includes("used the back button") && haystack.includes("secure web site"))
  );
}

function isLsePortalError(error) {
  return errorText(error).includes(LSE_PORTAL_ERROR_PREFIX.toLowerCase());
}

function lsePortalError(debug = {}) {
  const detail = [
    debug.title && `Title: ${debug.title}`,
    debug.url && `URL: ${debug.url}`,
    debug.text && `Visible text: ${debug.text}`,
  ]
    .filter(Boolean)
    .join(". ");
  return new Error(
    `${LSE_PORTAL_ERROR_PREFIX}: the accommodation site asked to close the browser and retry later.${
      detail ? ` ${detail}` : ""
    }`
  );
}

async function assertNotLseUnexpectedError(driver, text) {
  const title = await driver.getTitle().catch(() => "");
  const pageText = text ?? (await bodyText(driver).catch(() => ""));
  if (isLseUnexpectedErrorPage({ text: pageText, title })) {
    const url = await driver.getCurrentUrl().catch(() => "unknown");
    throw lsePortalError({
      title,
      url,
      text: String(pageText)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 12)
        .join(" | "),
    });
  }
}

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

function cdpCookiesToSelenium(cdpCookies = []) {
  return cdpCookies.map((cookie) => {
    const seleniumCookie = {
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      domain: cookie.domain,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    };
    if (cookie.sameSite && cookie.sameSite !== "None") {
      seleniumCookie.sameSite = cookie.sameSite;
    } else if (cookie.sameSite === "None") {
      seleniumCookie.sameSite = "None";
    }
    if (!cookie.session && Number(cookie.expires) > 0) {
      seleniumCookie.expiry = Math.floor(Number(cookie.expires));
    }
    return seleniumCookie;
  });
}

function seleniumCookiesToCdp(cookies = []) {
  return cookies
    .map((cookie) => {
      const domain = cookie.domain || "";
      if (!cookie.name || cookie.value == null || !domain) return null;
      const cdpCookie = {
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || "/",
        domain,
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
      };
      if (cookie.sameSite) cdpCookie.sameSite = cookie.sameSite;
      if (cookie.expiry) cdpCookie.expires = Number(cookie.expiry);
      return cdpCookie;
    })
    .filter(Boolean);
}

async function saveCookies(driver) {
  // Prefer CDP all-cookies so Microsoft SSO cookies are kept, not just the
  // current LSE host's ASP.NET_SessionId (which alone cannot restore login).
  let cookies;
  try {
    const result = await driver.sendAndGetDevToolsCommand("Network.getAllCookies", {});
    cookies = cdpCookiesToSelenium(result?.cookies || []);
  } catch (error) {
    console.warn(`CDP getAllCookies failed; falling back to current-domain cookies: ${error.message}`);
    cookies = await driver.manage().getCookies();
  }
  await writeJson(AUTH_COOKIES_PATH, cookies);
  return cookies;
}

async function applyCookies(driver, cookies) {
  const now = Math.floor(Date.now() / 1000);
  const valid = (cookies || []).filter((cookie) => !cookie.expiry || cookie.expiry > now);
  if (valid.length === 0) return false;

  // Set cookies on a blank document FIRST. Visiting the LSE lander before
  // setCookies races the ASP.NET "Validating and loading..." navigation and
  // aborts CDP with "loader has changed while resolving nodes".
  await driver.get("about:blank");
  try {
    await driver.sendAndGetDevToolsCommand("Network.enable", {});
    await driver.sendAndGetDevToolsCommand("Network.setCookies", {
      cookies: seleniumCookiesToCdp(valid),
    });
    return true;
  } catch (error) {
    console.warn(`CDP setCookies failed; falling back to per-domain addCookie: ${error.message}`);
  }

  // Fallback: group by domain and navigate before adding.
  const byDomain = new Map();
  for (const cookie of valid) {
    const domain = (cookie.domain || "").replace(/^\./, "");
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(cookie);
  }

  for (const [domain, domainCookies] of byDomain) {
    try {
      await driver.get(`https://${domain}/`);
      await settlePage(driver, 300);
      for (const cookie of domainCookies) {
        const seleniumCookie = { ...cookie };
        // Selenium rejects domain cookies that don't match the current host
        // when the leading-dot form is used inconsistently.
        try {
          await driver.manage().addCookie(seleniumCookie);
        } catch {
          delete seleniumCookie.domain;
          await driver.manage().addCookie(seleniumCookie).catch(() => {});
        }
      }
    } catch (error) {
      console.warn(`Could not restore cookies for ${domain}: ${error.message}`);
    }
  }

  return true;
}

async function loadCookies(driver) {
  if (!(await exists(AUTH_COOKIES_PATH))) {
    await driver.get(START_URL);
    await settlePage(driver, 500);
    return false;
  }

  const cookies = await readJson(AUTH_COOKIES_PATH);
  if (!Array.isArray(cookies) || cookies.length === 0) {
    await driver.get(START_URL);
    await settlePage(driver, 500);
    return false;
  }

  const applied = await applyCookies(driver, cookies);
  if (!applied) {
    await driver.get(START_URL);
    await settlePage(driver, 500);
    return false;
  }

  await driver.get(START_URL);
  await settlePage(driver, 500);
  return true;
}

async function clearBrowserCookies(driver) {
  try {
    await driver.sendAndGetDevToolsCommand("Network.clearBrowserCookies", {});
  } catch {
    await driver.manage().deleteAllCookies().catch(() => {});
  }
}

// Drop poisoned ASP.NET / Shibboleth cookies but keep Microsoft SSO cookies so
// re-entry often skips a fresh Authenticator prompt after the user browsed the portal.
async function invalidateAppSession(driver) {
  let retained = [];
  if (await exists(AUTH_COOKIES_PATH)) {
    const cookies = await readJson(AUTH_COOKIES_PATH);
    if (Array.isArray(cookies)) {
      retained = cookies.filter(
        (cookie) => isMicrosoftSsoCookie(cookie) && !isAccommodationAppCookie(cookie)
      );
      await writeJson(AUTH_COOKIES_PATH, retained);
    }
  }

  await clearBrowserCookies(driver);
  if (retained.length > 0) {
    await applyCookies(driver, retained);
  }
  return retained.length;
}

async function stripSavedAppSessionCookies() {
  if (!(await exists(AUTH_COOKIES_PATH))) return 0;
  const cookies = await readJson(AUTH_COOKIES_PATH);
  if (!Array.isArray(cookies)) return 0;
  const retained = cookies.filter(
    (cookie) => isMicrosoftSsoCookie(cookie) && !isAccommodationAppCookie(cookie)
  );
  await writeJson(AUTH_COOKIES_PATH, retained);
  return cookies.length - retained.length;
}

async function createDriver() {
  // Never reuse a Chrome profile across attempts/runners. Cached profiles from
  // GitHub Actions were correlated with LSE serving "An Error has Occurred".
  await fs.rm(CHROME_PROFILE_DIR, { recursive: true, force: true });
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

  // macOS local runs: Selenium Manager sometimes fails to locate Chrome unless
  // the binary path is set explicitly (symptoms: empty "newSession:" then exit).
  if (process.platform === "darwin") {
    options.setChromeBinaryPath(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    );
  }

  return new Builder().forBrowser("chrome").setChromeOptions(options).build();
}

async function waitForDocumentReady(driver, timeoutMs = 20000) {
  await driver.wait(async () => {
    try {
      const state = await driver.executeScript("return document.readyState");
      return state === "complete" || state === "interactive";
    } catch (error) {
      // Navigation in flight — keep polling until readyState is readable.
      if (isTransientPageError(error)) return false;
      throw error;
    }
  }, timeoutMs);
}

async function settlePage(driver, pauseMs = 750) {
  await waitForDocumentReady(driver);
  await sleep(pauseMs);
}

// Prefer script-based text reads over WebElement.getText(): locating <body>
// then calling getText() races with LSE postbacks and throws stale-element /
// "no such execution context" under Chrome.
async function bodyText(driver, attempts = BODY_TEXT_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await waitForDocumentReady(driver);
      const text = await driver.executeScript(
        "return document.body ? (document.body.innerText || document.body.textContent || '') : ''"
      );
      return typeof text === "string" ? text : String(text || "");
    } catch (error) {
      lastError = error;
      const retryable = isTransientPageError(error) || isTimeoutError(error);
      if (!retryable || attempt === attempts) {
        throw error;
      }
      await sleep(400 * attempt);
    }
  }
  throw lastError;
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
  if (/please\s+login/i.test(text)) return true;

  const url = await driver.getCurrentUrl().catch(() => "");
  if (url.includes("login.microsoftonline.com")) return true;

  // Logged-out lander fallback: Login CTA present and no booking entry points.
  return (
    /\blogin\b/i.test(text) &&
    !/continue booking/i.test(text) &&
    !/select your year of stay/i.test(text) &&
    !/select your room type/i.test(text)
  );
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

  // Always drop the accommodation ASP.NET session before login recovery.
  // Opening the portal in another browser poisons it and leaves the lander on
  // "Validating and loading your details" if we reuse the same SessionId.
  await invalidateAppSession(driver);

  await driver.get(START_URL);
  await waitForLanderReady(driver, Math.min(LANDER_READY_MS, 25000)).catch((error) => {
    if (error.message.includes("Not logged in") || isLsePortalError(error)) {
      return "";
    }
    throw error;
  });

  await clickButtonByText(driver, "login", 8000).catch(() => false);
  await waitForLanderReady(driver, 15000).catch(() => null);
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

  const currentUrl = await driver.getCurrentUrl().catch(() => "");
  if (!clickedStaff && !currentUrl.includes("login.microsoftonline.com")) {
    const debug = await pageDebug(driver);
    if (isLanderLoading(debug.text)) {
      throw new Error(
        `Not logged in. LSE lander stuck validating session during login. URL: ${debug.url}. Title: ${debug.title}. Visible text: ${debug.text}`
      );
    }
    if (isStaleIdpRequestPage(debug)) {
      throw new Error(
        `Not logged in. LSE identity provider returned a stale request (usually after opening the portal in another browser). URL: ${debug.url}. Title: ${debug.title}. Visible text: ${debug.text}`
      );
    }
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
    await pauseCheckerForAuth(message);
    await sendOperationalEmail("LSE accommodation checker needs email verification", message);
    const emailCode = await waitForDashboardEmailCode(promptedAt);
    await submitEmailCode(driver, emailCode);
    await clickButtonByText(driver, "yes", 5000).catch(() => false);
    const loggedInAfterEmailCode = await driver
      .wait(async () => loggedInAccommodationVisible(driver), 15000)
      .catch(() => false);
    if (loggedInAfterEmailCode) {
      await saveCookies(driver);
      await resumeCheckerAfterAuth();
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
  await pauseCheckerForAuth(message);
  await sendOperationalEmail("LSE accommodation checker needs Authenticator approval", message);

  await waitForMfaApproval(driver, code);
  await clickButtonByText(driver, "yes", 5000).catch(() => false);
  await driver.wait(async () => loggedInAccommodationVisible(driver), 60000);
  await saveCookies(driver);
  await resumeCheckerAfterAuth();

  await writeStatus({
    state: "running",
    message: "LSE login refreshed successfully; continuing availability check.",
  });
}

async function waitForLanderReady(driver, timeoutMs = LANDER_READY_MS) {
  const startedAt = Date.now();
  let lastText = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastText = await bodyText(driver);
      await assertNotLseUnexpectedError(driver, lastText);
      if (!isLanderLoading(lastText)) {
        return lastText;
      }
    } catch (error) {
      if (isLsePortalError(error)) throw error;
      if (!isTransientPageError(error) && !isTimeoutError(error)) throw error;
    }
    await sleep(1500);
  }

  const debug = await pageDebug(driver);
  if (isLanderLoading(debug.text) || isLanderLoading(lastText)) {
    // One refresh before declaring the session dead — LSE sometimes leaves the
    // validating spinner up until a reload finishes the postback.
    await driver.navigate().refresh().catch(async () => driver.get(START_URL));
    await settlePage(driver, 1200);
    const refreshDeadline = Date.now() + 20000;
    while (Date.now() < refreshDeadline) {
      const refreshed = await bodyText(driver).catch(() => "");
      try {
        await assertNotLseUnexpectedError(driver, refreshed);
      } catch (error) {
        if (isLsePortalError(error)) throw error;
      }
      if (!isLanderLoading(refreshed)) {
        return refreshed;
      }
      await sleep(1500);
    }

    const after = await pageDebug(driver);
    // Stuck validating usually means the restored SSO session is half-dead.
    // Phrase includes "Not logged in" so performCheckAttempt refreshes login.
    throw new Error(
      `Not logged in. LSE lander stuck validating session. URL: ${after.url}. Title: ${after.title}. Visible text: ${after.text}`
    );
  }

  return lastText || debug.text || "";
}

async function loadAvailabilityLander(driver) {
  // loadCookies already navigates to START_URL when cookies were restored.
  // Only re-get when we are not already on the lander.
  const currentUrl = await driver.getCurrentUrl().catch(() => "");
  if (!currentUrl.includes("lsestudentaccommodation.lse.ac.uk")) {
    await driver.get(START_URL);
  }
  await settlePage(driver);

  try {
    return await waitForLanderReady(driver);
  } catch (error) {
    if (isLsePortalError(error) || error.message.includes("Not logged in")) {
      throw error;
    }
    // One hard reload when the lander keeps navigating during the first read.
    if (!isTransientPageError(error) && !isTimeoutError(error)) {
      throw error;
    }
    await driver.get(START_URL);
    await settlePage(driver, 1200);
    return waitForLanderReady(driver);
  }
}

async function reachAvailabilityPage(driver) {
  let text = await loadAvailabilityLander(driver);
  if (await accommodationLoginVisible(driver)) {
    throw new Error(
      "Not logged in. Run `npm run login`, complete LSE login, then run the checker again."
    );
  }

  await clickIfVisible(
    driver,
    By.xpath("//a[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'continue booking')]")
  );
  await settlePage(driver, 500);
  await assertNotLseUnexpectedError(driver);

  text = await bodyText(driver);
  if (text.includes("Would you like to book a room in urbanest Westminster Bridge")) {
    await continueFromWestminsterQuestion(driver);
    await settlePage(driver, 500);
    await assertNotLseUnexpectedError(driver);
  }

  text = await bodyText(driver);
  if (text.includes("About You")) {
    const confirmed = await clickButtonByText(driver, "confirm", 8000);
    if (!confirmed) {
      throw new Error("Could not click Confirm on the About You page.");
    }
    await settlePage(driver, 500);
    await assertNotLseUnexpectedError(driver);
  }

  try {
    await driver.wait(async () => {
      try {
        const current = await bodyText(driver);
        await assertNotLseUnexpectedError(driver, current);
        if (isLanderLoading(current)) return false;
        return current.includes("Select your room type");
      } catch (error) {
        if (isLsePortalError(error)) throw error;
        if (isTransientPageError(error) || isTimeoutError(error)) return false;
        throw error;
      }
    }, 30000);
  } catch (error) {
    if (isLsePortalError(error)) throw error;
    if (error.message.includes("Not logged in")) throw error;
    const debug = await pageDebug(driver);
    if (isLseUnexpectedErrorPage(debug)) {
      throw lsePortalError(debug);
    }
    if (isLanderLoading(debug.text)) {
      throw new Error(
        `Not logged in. LSE lander stuck validating session. URL: ${debug.url}. Title: ${debug.title}. Visible text: ${debug.text}`
      );
    }
    throw new Error(
      `Timed out waiting for availability page. URL: ${debug.url}. Title: ${debug.title}. Visible text: ${debug.text}`
    );
  }
}

// UI chrome inside a .RoomRow that is not room information.
const ROOM_ROW_NOISE_LINES = new Set(
  [
    "add to comparison",
    "view comparisons",
    "images",
    "facilities",
    "more info",
    "map",
    "book now",
  ].map((line) => line.toLowerCase())
);

// Turn a .RoomRow innerText blob into { name, fields, lines } where name is
// the residence/hall and fields are the "Key: Value" attributes shown on the
// row (Room type, Contract length, Weekly price, ...).
function parseRoomDetails(roomText = "") {
  const lines = String(roomText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !ROOM_ROW_NOISE_LINES.has(line.toLowerCase()));

  const fields = {};
  let name = "";
  for (const line of lines) {
    const match = line.match(/^([^:]{2,40}):\s*(.+)$/);
    if (match) {
      fields[match[1].trim()] = match[2].trim();
    } else if (!name) {
      name = line;
    }
  }

  return { name: name || "Unknown residence", fields, lines };
}

function roomLabel(room) {
  const { name, fields } = parseRoomDetails(room.text);
  const type = fields["Room type"];
  const contract = fields["Contract length"];
  const price = fields["Weekly price"];
  const detail = [type, contract, price && `${price}/wk`].filter(Boolean).join(", ");
  return detail ? `${name} — ${detail}` : name;
}

// Short residence list for the email subject, e.g.
// "Sidney Webb House ×2, High Holborn".
function summarizeRoomsForSubject(rooms = []) {
  if (rooms.length === 0) return "";
  const counts = new Map();
  for (const room of rooms) {
    const { name } = parseRoomDetails(room.text);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
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

function fingerprint(result) {
  if (result.noAvailability) return "no-availability";
  if (result.rooms.length > 0) {
    return JSON.stringify(result.rooms.map((room) => ({ text: room.text, data: room.data })));
  }
  return `changed-page:${result.pageSummary}`;
}

function availabilityEmailSubject(result) {
  const summary = summarizeRoomsForSubject(result.rooms);
  if (summary) {
    // Room list in the subject: shows what's available at a glance and gives
    // different availability a different subject, so mail clients start a new
    // thread when the rooms change instead of burying every alert in one.
    return `LSE rooms available: ${summary}`;
  }
  return "LSE accommodation page changed (possible availability)";
}

function formatAvailabilityEmail(result) {
  if (result.rooms.length === 0) {
    return [
      "The LSE accommodation page changed but no room rows could be parsed.",
      "Open the booking page to check manually:",
      result.url,
      "",
      `Checked at: ${result.checkedAt}`,
      "",
      "Visible page summary:",
      result.pageSummary,
    ].join("\n");
  }

  const overview = result.rooms.map((room, index) => `  ${index + 1}. ${roomLabel(room)}`);

  const roomDetails = result.rooms
    .map((room, index) => {
      const { name, fields } = parseRoomDetails(room.text);
      const fieldLines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
      const dataLines = Object.entries(room.data).map(([key, value]) => `${key}: ${value}`);
      return [`Room ${index + 1}: ${name}`, ...fieldLines, ...dataLines].join("\n");
    })
    .join("\n\n---\n\n");

  return [
    `${result.rooms.length} room(s) available on the LSE accommodation portal:`,
    "",
    ...overview,
    "",
    `Book here: ${result.url}`,
    `Checked at: ${result.checkedAt}`,
    "",
    "Full details:",
    "",
    roomDetails,
  ].join("\n");
}

const MAIL_SEND_ATTEMPTS = Number(process.env.MAIL_SEND_ATTEMPTS || 3);

function parseEmailList(value = "") {
  return String(value)
    .split(/[,;]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function extraAvailabilityEmailTo(value = process.env.EXTRA_AVAILABILITY_EMAIL_TO) {
  return parseEmailList(value);
}

function availabilityEmailRecipients(
  emailTo = process.env.EMAIL_TO,
  extraTo = process.env.EXTRA_AVAILABILITY_EMAIL_TO
) {
  const seen = new Set();
  const recipients = [];
  for (const email of [...parseEmailList(emailTo), ...extraAvailabilityEmailTo(extraTo)]) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(email);
  }
  return recipients;
}

async function sendMail(subject, text, { to } = {}) {
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
        to: to || process.env.EMAIL_TO,
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
  await sendMail(availabilityEmailSubject(result), formatAvailabilityEmail(result), {
    to: availabilityEmailRecipients().join(", "),
  });
}

async function sendOperationalEmail(subject, text) {
  try {
    await sendMail(subject, text);
  } catch (error) {
    // Never block MFA / login recovery on SMTP misconfig — the dashboard status
    // and Authenticator push are the primary signals.
    console.warn(`Operational email skipped: ${redactPii(error.message)}`);
  }
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
      const needsLogin =
        error.message.includes("Not logged in") ||
        /could not reach microsoft sign-in/i.test(error.message || "");
      if (!needsLogin) throw error;
      console.warn(
        `Session recovery: clearing accommodation ASP.NET cookies before login (${redactPii(error.message)})`
      );
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

    const roomSummary = summarizeRoomsForSubject(result.rooms) || "page changed, no rooms parsed";

    const alreadyAlerted =
      !SEND_ON_EVERY_HIT && previous?.fingerprint === currentFingerprint;
    if (alreadyAlerted) {
      await persistState();
      await writeStatus({
        state: "availability_found",
        message: `Availability still present (${roomSummary}); duplicate email skipped.`,
        checkedAt: result.checkedAt,
        noAvailability: false,
        roomCount: result.rooms.length,
        summary: result.pageSummary,
      });
      await recordCheckOutcome(
        "availability_found",
        `Availability still present (${roomSummary}); duplicate email skipped.`
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
      message: `Availability found (${roomSummary}); email sent.`,
      checkedAt: result.checkedAt,
      noAvailability: false,
      roomCount: result.rooms.length,
      summary: result.pageSummary,
    });
    await recordCheckOutcome("availability_found", `Availability found (${roomSummary}); email sent.`);
    console.log(`[${result.checkedAt}] Availability signal found; email sent.`);
  } finally {
    await driver.quit();
  }
}

function isAuthChallengeError(error) {
  const message = errorText(error);
  return [
    "microsoft authenticator approval",
    "email verification code",
    "needs_mfa",
    "needs_email_code",
  ].some((needle) => message.includes(needle));
}

function isRetryableError(error) {
  // Never retry MFA / email-code failures: a retry opens a fresh browser and
  // triggers a brand-new Authenticator number, which is what spammed the user.
  if (isAuthChallengeError(error)) {
    return false;
  }

  if (isTransientPageError(error) || isTimeoutError(error) || isLsePortalError(error)) {
    return true;
  }

  const message = errorText(error);
  return [
    "no such element",
    "chrome not reachable",
    "target window already closed",
    "net::",
    "email send failed",
    "could not reach microsoft sign-in",
    "lander stuck validating",
    "stale request",
  ].some((needle) => message.includes(needle));
}

async function pauseCheckerForAuth(reason) {
  // Stop follow-up cron runs from starting another Microsoft login while the
  // current run is waiting for Authenticator / email code.
  await writeControl({
    enabled: false,
    updatedAt: new Date().toISOString(),
    updatedBy: "checker-auth-pause",
    pauseReason: reason,
  });
}

async function resumeCheckerAfterAuth() {
  await writeControl({
    enabled: true,
    updatedAt: new Date().toISOString(),
    updatedBy: "checker-auth-resume",
    pauseReason: null,
  });
}

function outcomeStateForError(error) {
  const message = error?.message || "";
  if (message.includes("LSE_EMAIL")) return "login_failed";
  if (isLsePortalError(error)) return "site_error";
  return "error";
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

      const portalDown = isLsePortalError(error);
      const poisonedSession =
        /lander stuck validating|could not reach microsoft sign-in|stale request/i.test(
          error.message || ""
        );
      if (poisonedSession) {
        const removed = await stripSavedAppSessionCookies();
        if (removed > 0) {
          console.warn(
            `Stripped ${removed} poisoned accommodation cookie(s) before fresh-browser retry.`
          );
        }
      }

      const message = portalDown
        ? `Attempt ${attempt}/${CHECK_ATTEMPTS} hit an LSE portal error page; waiting before a fresh browser retry. ${error.message}`
        : poisonedSession
          ? `Attempt ${attempt}/${CHECK_ATTEMPTS} hit a poisoned LSE session (often after opening the portal in another browser); clearing app cookies and retrying. ${error.message}`
          : `Attempt ${attempt}/${CHECK_ATTEMPTS} failed with a retryable browser/page error; retrying with a fresh browser. ${error.message}`;
      console.warn(redactPii(message));
      await writeStatus({
        state: "retrying",
        message,
        error: error.stack || error.message,
      });
      await sleep(
        portalDown || poisonedSession ? SITE_ERROR_RETRY_MS * attempt : 5000 * attempt
      );
    }
  }

  throw lastError;
}

if (require.main === module) {
  main().catch(async (error) => {
    const state = outcomeStateForError(error);
    await writeStatus({
      state,
      message: error.message,
      error: error.stack || error.message,
    });
    await recordCheckOutcome(state, error.message);
    console.error(redactPii(error.message));
    process.exitCode = 1;
  });
}

module.exports = {
  availabilityEmailRecipients,
  availabilityEmailSubject,
  BODY_TEXT_ATTEMPTS,
  bodyText,
  extraAvailabilityEmailTo,
  formatAvailabilityEmail,
  hasNoAvailabilityBanner,
  isAccommodationAppCookie,
  isAuthChallengeError,
  isLanderLoading,
  parseRoomDetails,
  roomLabel,
  summarizeRoomsForSubject,
  isLsePortalError,
  isLseUnexpectedErrorPage,
  isMicrosoftSsoCookie,
  isRetryableError,
  isStaleIdpRequestPage,
  isTimeoutError,
  isTransientPageError,
  lsePortalError,
  NO_AVAILABILITY_TEXT,
  outcomeStateForError,
  settlePage,
  waitForDocumentReady,
};
