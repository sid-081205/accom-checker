const fs = require("fs/promises");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { Builder } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const START_URL =
  "https://lsestudentaccommodation.lse.ac.uk/Pages/EN/Lander.aspx?wf=Hub";
const AUTH_COOKIES_PATH = path.resolve(".auth/lse-cookies.json");

async function createDriver() {
  const options = new chrome.Options();
  options.addArguments("--window-size=1440,1200");
  return new Builder().forBrowser("chrome").setChromeOptions(options).build();
}

async function main() {
  const driver = await createDriver();

  await driver.get(START_URL);
  console.log("Complete LSE login in the browser window.");
  console.log("Navigate until you can see the accommodation dashboard or available rooms page.");

  const rl = readline.createInterface({ input, output });
  await rl.question("Press Enter here when login is complete...");
  rl.close();

  const cookies = await driver.manage().getCookies();
  await fs.mkdir(path.dirname(AUTH_COOKIES_PATH), { recursive: true });
  await fs.writeFile(AUTH_COOKIES_PATH, JSON.stringify(cookies, null, 2));
  await driver.quit();

  console.log(`Saved login cookies to ${AUTH_COOKIES_PATH}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
