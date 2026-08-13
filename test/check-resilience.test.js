const assert = require("assert");
const {
  isLanderLoading,
  isLsePortalError,
  isLseUnexpectedErrorPage,
  isRetryableError,
  isTimeoutError,
  isTransientPageError,
  lsePortalError,
  outcomeStateForError,
} = require("../src/check");

function testTransientPageErrors() {
  assert.ok(
    isTransientPageError({
      message: "stale element reference: stale element not found\n  (Session info: chrome=150.0.7871.128)",
    })
  );
  assert.ok(
    isTransientPageError({
      message: "timeout\nfrom no such execution context\n  (Session info: chrome=150.0.7871.128)",
    })
  );
  assert.ok(
    isTransientPageError({
      name: "JavascriptError",
      message: "javascript error: synchro: document was unloaded while waiting",
    })
  );
  assert.ok(
    isTransientPageError({
      message: "timeout\nfrom aborted by navigation: loader has changed while resolving nodes",
    })
  );
  assert.ok(!isTransientPageError({ message: "Not logged in. Run `npm run login`" }));
}

function testLanderLoadingDetection() {
  assert.ok(
    isLanderLoading(
      "Skip to content\nLoading...\nValidating and loading your details, please wait...\nHalls Life"
    )
  );
  assert.ok(!isLanderLoading("Select your Year of Stay\nContinue Booking"));
  assert.ok(!isLanderLoading("Select your room type\nNo residences currently have availability"));

  const { isAccommodationAppCookie } = require("../src/check");
  assert.ok(
    isAccommodationAppCookie({
      domain: "lsestudentaccommodation.lse.ac.uk",
      name: "ASP.NET_SessionId",
    })
  );
  assert.ok(
    !isAccommodationAppCookie({
      domain: "gate.library.lse.ac.uk",
      name: "__Host-shib_idp_session",
    })
  );
  assert.ok(
    isRetryableError({
      message:
        "Could not reach Microsoft sign-in from LSE identity page. Visible text: Validating and loading your details",
    })
  );
  assert.ok(
    isRetryableError({
      message: "Not logged in. LSE lander stuck validating session. URL: x",
    })
  );
}

function testTimeoutDetection() {
  assert.ok(isTimeoutError({ message: "timeout" }));
  assert.ok(isTimeoutError({ name: "TimeoutError", message: "Waiting for element timed out: 20000" }));
  assert.ok(!isTimeoutError({ message: "no such element: Unable to locate element" }));
}

function testLseUnexpectedErrorPageDetection() {
  assert.ok(
    isLseUnexpectedErrorPage({
      title: "An Error has Occurred",
      text: "Unexpected Error\nSorry, there has been an unexpected error. Please close your browser and retry after a few minutes",
    })
  );
  assert.ok(!isLseUnexpectedErrorPage({ title: "Hub", text: "Select your Year of Stay" }));
  const portalError = lsePortalError({
    title: "An Error has Occurred",
    url: "https://lsestudentaccommodation.lse.ac.uk/Pages/EN/Lander.aspx?wf=Hub",
  });
  assert.ok(isLsePortalError(portalError));
  assert.ok(isRetryableError(portalError));
  assert.strictEqual(outcomeStateForError(portalError), "site_error");
}

function testRetryableBrowserErrors() {
  const { isAuthChallengeError } = require("../src/check");
  assert.ok(
    isRetryableError({
      message: "stale element reference: stale element not found",
    })
  );
  assert.ok(
    isRetryableError({
      message: "timeout\nfrom no such execution context",
    })
  );
  assert.ok(isRetryableError({ message: "chrome not reachable" }));
  assert.ok(isRetryableError({ message: "Email send failed after 3 attempts: Connection timeout" }));
  assert.ok(!isRetryableError({ message: "LSE_EMAIL and LSE_PASSWORD are required" }));
  assert.ok(
    isAuthChallengeError({
      message: "Timed out waiting for Microsoft Authenticator approval for code 37.",
    })
  );
  assert.ok(
    !isRetryableError({
      message: "Timed out waiting for Microsoft Authenticator approval for code 37.",
    })
  );
  assert.ok(
    !isRetryableError({
      message: "Timed out waiting for email verification code from the dashboard.",
    })
  );
}

async function testBodyTextRetriesTransientErrors() {
  const { bodyText } = require("../src/check");
  let scriptCalls = 0;
  const driver = {
    async wait(condition) {
      // waitForDocumentReady polls until truthy.
      for (let i = 0; i < 5; i += 1) {
        if (await condition()) return true;
      }
      throw new Error("timeout");
    },
    async executeScript(script) {
      if (script.includes("readyState")) {
        return "complete";
      }
      scriptCalls += 1;
      if (scriptCalls < 3) {
        const error = new Error("stale element reference: stale element not found");
        error.name = "StaleElementReferenceError";
        throw error;
      }
      return "Select your room type\nNo residences currently have availability";
    },
  };

  const text = await bodyText(driver, 4);
  assert.match(text, /Select your room type/);
  assert.strictEqual(scriptCalls, 3);
}

testTransientPageErrors();
testLanderLoadingDetection();
testTimeoutDetection();
testLseUnexpectedErrorPageDetection();
testRetryableBrowserErrors();
testBodyTextRetriesTransientErrors()
  .then(() => {
    console.log("Checker resilience unit tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
