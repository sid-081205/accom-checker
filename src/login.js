const fs = require("fs/promises");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { chromium } = require("playwright");

const START_URL =
  "https://lsestudentaccommodation.lse.ac.uk/Pages/EN/Lander.aspx?wf=Hub";
const AUTH_STATE_PATH = path.resolve(".auth/lse-storage-state.json");

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  console.log("Complete LSE login in the browser window.");
  console.log("Navigate until you can see the accommodation dashboard or available rooms page.");

  const rl = readline.createInterface({ input, output });
  await rl.question("Press Enter here when login is complete...");
  rl.close();

  await fs.mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await context.storageState({ path: AUTH_STATE_PATH });
  await browser.close();

  console.log(`Saved login state to ${AUTH_STATE_PATH}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
