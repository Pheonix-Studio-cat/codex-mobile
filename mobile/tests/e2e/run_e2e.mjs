// End-to-end test: a real `codex app-server`, the bridge, and the web
// interface in a phone-sized browser. The model is mock_responses.py, so the
// test needs no account and no internet.
//
//   CODEX_BIN=/path/to/codex [CHINOOK_HOME=/path/to/Chinook-security] \
//     node mobile/tests/e2e/run_e2e.mjs
//
// Needs the `playwright` package and a Chromium it can launch.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const bridgeScript = resolve(here, "../../bridge/codex_mobile.py");
const mockScript = resolve(here, "mock_responses.py");
const codexBin = process.env.CODEX_BIN || "codex";
const screenshots = process.env.SCREENSHOT_DIR || "";
const children = [];
let failures = 0;
let lastPage = null;

function check(condition, message) {
  if (condition) {
    console.log("ok   " + message);
  } else {
    failures += 1;
    console.log("FAIL " + message);
  }
}

function start(command, args, options) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  children.push(child);
  return { child, output: () => output };
}

async function waitFor(predicate, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out waiting for " + what);
}

async function startBridge(root, port, config, extraArgs = []) {
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, "config.toml"), config);
  const token =
    "e2e-" +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2);
  writeFileSync(join(root, "token"), token + "\n");
  const bridge = start(
    "python3",
    [
      bridgeScript,
      "--port",
      String(port),
      "--workspace",
      workspace,
      "--codex",
      codexBin,
      "--token-file",
      join(root, "token"),
      ...extraArgs,
    ],
    { env: { ...process.env, CODEX_HOME: home } },
  );
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: "Bearer " + token },
      });
      const status = await response.json();
      return status.appServer && status.appServer.codex === "ready";
    } catch {
      return false;
    }
  }, "bridge and codex app-server").catch((error) => {
    console.log(bridge.output());
    throw error;
  });
  return {
    token,
    workspace,
    bridge,
    url: `http://127.0.0.1:${port}/#token=${token}`,
  };
}

async function shot(page, name) {
  if (screenshots)
    await page.screenshot({
      path: join(screenshots, name + ".png"),
      fullPage: false,
    });
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codex-mobile-e2e-"));
  const portFile = join(root, "mock-port");
  start("python3", [mockScript, "--port-file", portFile]);
  await waitFor(
    () => existsSync(portFile) && readFileSync(portFile, "utf8").length > 0,
    "mock model",
  );
  const mockPort = readFileSync(portFile, "utf8").trim();

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  );
  const context = await browser.newContext({ ...devices["iPhone 13"] });

  try {
    // ---------------------------------------------------------------
    // 1. Signed in (mock provider): a full turn with an approval.
    // ---------------------------------------------------------------
    const chinook = process.env.CHINOOK_HOME
      ? ["--chinook", process.env.CHINOOK_HOME]
      : [];
    // Stands in for GitHub Pages: the same files, served from another origin.
    const hostedPort = 18950;
    start("python3", [
      "-m",
      "http.server",
      String(hostedPort),
      "--bind",
      "127.0.0.1",
      "--directory",
      resolve(here, "../../web"),
    ]);
    chinook.push("--allow-origin", `http://127.0.0.1:${hostedPort}`);
    const one = await startBridge(
      join(root, "one"),
      18901,
      [
        'model = "mock-model"',
        'model_provider = "mock"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        "",
        "[model_providers.mock]",
        'name = "Mock"',
        `base_url = "http://127.0.0.1:${mockPort}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "",
      ].join("\n"),
      chinook,
    );
    // A planted, format-valid-looking credential for the secret bot to find.
    // Built from parts so that this file itself is not a finding.
    writeFileSync(
      join(one.workspace, "settings.py"),
      'API_TOKEN = "' + "ghp_" + "A".repeat(36) + '"\n',
    );
    // A dependency with published advisories. With OSV.dev reachable the
    // dependency bot must report it; without, it must say it proves nothing.
    // Either way it must not say "clean".
    writeFileSync(
      join(one.workspace, "requirements.txt"),
      "requests==2.19.0\n",
    );

    const page = await context.newPage();
    lastPage = page;
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    await page.goto(one.url);
    await page.waitForSelector("#view-chat:not([hidden])");
    check(
      !(await page.url()).includes("token="),
      "the token is removed from the address bar",
    );
    check(await page.isVisible("#composer-bar"), "the composer is visible");
    await shot(page, "01-new-thread");

    await page.fill("#prompt", "Create a marker file, please.");
    await page.tap("#send");
    await page.waitForSelector(".approval", { timeout: 30000 });
    const approvalText = await page.textContent(".approval");
    check(
      /touch codex-mobile-e2e\.txt/.test(approvalText),
      "the approval card shows the command",
    );
    await shot(page, "02-approval");

    const buttons = await page
      .locator(".approval button")
      .evaluateAll((els) => els.map((el) => el.textContent));
    check(
      buttons.includes("Approve"),
      "the approval offers Approve: " + buttons.join(" | "),
    );
    await page.tap(".approval button.primary");
    await page.waitForSelector(".approval", {
      state: "detached",
      timeout: 30000,
    });
    check(true, "the approval card disappears after answering");

    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".msg.agent")).some((el) =>
          /step two/.test(el.textContent),
        ),
      null,
      { timeout: 30000 },
    );
    await page.waitForSelector("#stop[hidden]", {
      state: "attached",
      timeout: 30000,
    });
    const agentHtml = await page
      .locator(".msg.agent")
      .first()
      .evaluate((el) => el.innerHTML);
    check(
      /<strong>codex-mobile-e2e\.txt<\/strong>/.test(agentHtml),
      "markdown bold is rendered",
    );
    check(/<li>step one<\/li>/.test(agentHtml), "markdown list is rendered");
    check(
      existsSync(join(one.workspace, "codex-mobile-e2e.txt")),
      "the approved command really ran on the computer",
    );
    check(
      (await page.$$(".msg.user")).length === 1,
      "the user message appears exactly once",
    );
    check(
      (await page.$$(".msg.user.pending")).length === 0,
      "the user message is confirmed by Codex",
    );
    const activity = await page.textContent(".activity .label");
    check(/touch/.test(activity), "the command shows up as an activity row");
    await shot(page, "03-answer");

    // Reload: the thread comes back from Codex's own history.
    await page.reload();
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".msg.agent")).some((el) =>
          /step two/.test(el.textContent),
        ),
      null,
      { timeout: 30000 },
    );
    check(true, "after a reload the thread is restored from Codex");

    // The drawer lists the thread.
    await page.tap("#menu-button");
    await page.waitForSelector("#drawer:not([hidden])");
    const listed = await page
      .locator("#thread-list li")
      .evaluateAll((els) => els.length);
    check(listed >= 1, "the drawer lists the thread");
    await shot(page, "04-drawer");

    // Security view.
    await page.tap("#tab-security");
    await page.waitForSelector("#view-security:not([hidden])");
    if (process.env.CHINOOK_HOME) {
      await page.waitForSelector("#sec-run:not([disabled])");
      await page.tap("#sec-run");
      await page.waitForSelector(".bot-card", { timeout: 300000 });
      const cards = await page
        .locator(".bot-card")
        .evaluateAll((els) => els.map((el) => el.textContent));
      check(cards.length === 5, "all five bots report: " + cards.length);
      const secret = cards.find((text) => text.startsWith("secret-bot")) || "";
      check(
        /finding/.test(secret) && /settings\.py/.test(secret),
        "the secret bot finds the planted token",
      );
      const page_text = await page.textContent("#view-security");
      check(
        !page_text.includes("A".repeat(36)),
        "the secret value itself is never shown",
      );
      // The dependency bot asks OSV.dev. Without network it cannot know, and
      // must say so instead of showing "clean".
      const dependency =
        cards.find((text) => text.startsWith("dependency-bot")) || "";
      const unproven = /proves nothing/.test(dependency);
      check(
        unproven
          ? /does not count as passing/.test(dependency)
          : /finding/.test(dependency),
        "the dependency bot is never 'clean' for a vulnerable pin (" +
          (unproven ? "OSV unreachable" : "OSV answered") +
          ")",
      );
      await shot(page, "05-security");
    } else {
      const version = await page.textContent("#sec-version");
      check(/not installed/.test(version), "without Chinook the view says so");
      check(
        await page.isDisabled("#sec-run"),
        "without Chinook the scan button is disabled",
      );
      console.log("skip the scan itself: CHINOOK_HOME is not set");
    }

    // The hosted interface (another origin, like GitHub Pages) pairs through
    // the link and runs a whole turn against the same bridge.
    const hosted = await context.newPage();
    const hostedErrors = [];
    hosted.on("pageerror", (error) => hostedErrors.push(String(error)));
    await hosted.goto(
      `http://127.0.0.1:${hostedPort}/#bridge=http://127.0.0.1:18901&token=${one.token}`,
    );
    await hosted.waitForSelector("#view-chat:not([hidden])", {
      timeout: 30000,
    });
    check(
      !hosted.url().includes("token="),
      "hosted: the token is removed from the address bar",
    );
    await hosted.evaluate(() =>
      document.getElementById("new-thread-button").click(),
    );
    await hosted.fill("#prompt", "Once more, from the hosted page.");
    await hosted.tap("#send");
    await hosted.waitForSelector(".approval", { timeout: 30000 });
    await hosted.tap(".approval button.primary");
    await hosted.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".msg.agent")).some((el) =>
          /step two/.test(el.textContent),
        ),
      null,
      { timeout: 30000 },
    );
    check(true, "hosted: a whole turn with approval works across origins");
    check(
      hostedErrors.length === 0,
      "hosted: no page errors" +
        (hostedErrors.length ? ": " + hostedErrors.join(" / ") : ""),
    );
    await shot(hosted, "08-hosted");
    await hosted.close();

    // An origin the bridge does not list cannot use it, even with the token.
    const stranger = await context.newPage();
    await stranger.goto(
      `http://localhost:${hostedPort}/#bridge=http://127.0.0.1:18901&token=${one.token}`,
    );
    await stranger.waitForSelector("#view-pair:not([hidden])", {
      timeout: 30000,
    });
    const strangerError = await stranger.textContent("#pair-error");
    check(
      /No bridge answered|allow this page/.test(strangerError),
      "an unlisted origin is refused: " + strangerError.trim(),
    );
    await stranger.close();

    // iPad: landscape keeps the thread list open, portrait centres one
    // column and slides the list in; a hardware keyboard sends with Enter.
    for (const [deviceName, sidebar] of [
      ["iPad Pro 11 landscape", true],
      ["iPad Pro 11", false],
    ]) {
      const tablet = await browser.newContext({ ...devices[deviceName] });
      const pad = await tablet.newPage();
      const padErrors = [];
      pad.on("pageerror", (error) => padErrors.push(String(error)));
      await pad.goto(one.url);
      await pad.waitForSelector("#view-chat:not([hidden])", { timeout: 30000 });
      const layout = await pad.evaluate(() => {
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        return {
          width: window.innerWidth,
          drawerVisible: !document.getElementById("drawer").hidden,
          menuVisible:
            getComputedStyle(document.getElementById("menu-button")).display !==
            "none",
          messages: box("messages").width,
          messagesLeft: box("messages").left,
          main: box("view-chat"),
          hint: getComputedStyle(document.querySelector(".kbd-hint")).display,
        };
      });
      check(
        layout.drawerVisible === sidebar && layout.menuVisible === !sidebar,
        `${deviceName} (${layout.width}px): thread list ${sidebar ? "stays open" : "slides in"}`,
      );
      check(
        layout.messages <= 860,
        `${deviceName}: the conversation is a reading column (${Math.round(layout.messages)}px)`,
      );
      const centred =
        Math.abs(
          layout.messagesLeft -
            layout.main.left -
            (layout.main.width - layout.messages) / 2,
        ) < 2;
      check(centred, `${deviceName}: the column is centred`);
      check(
        layout.hint !== "none",
        `${deviceName}: the keyboard shortcuts are shown`,
      );

      // Enter sends (no on-screen keyboard is covering the page).
      await pad.keyboard.press("Meta+k");
      await pad.fill("#prompt", "From the iPad keyboard.");
      await pad.press("#prompt", "Enter");
      await pad.waitForSelector(".approval", { timeout: 30000 });
      check(true, `${deviceName}: Enter sends with a hardware keyboard`);
      await shot(pad, "09-" + deviceName.replace(/\s+/g, "-").toLowerCase());
      await pad.click(".approval button.primary");
      await pad.waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".msg.agent")).some((el) =>
            /step two/.test(el.textContent),
          ),
        null,
        { timeout: 30000 },
      );
      check(
        padErrors.length === 0,
        `${deviceName}: no page errors` +
          (padErrors.length ? ": " + padErrors.join(" / ") : ""),
      );
      await tablet.close();
    }

    // Without the token nothing works.
    const denied = await fetch("http://127.0.0.1:18901/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "thread/list", params: {} }),
    });
    check(
      denied.status === 401,
      "a request without the token is refused (" + denied.status + ")",
    );
    const foreign = await fetch("http://127.0.0.1:18901/api/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + one.token,
        "Origin": "https://evil.example",
      },
      body: JSON.stringify({ method: "thread/list", params: {} }),
    });
    check(
      foreign.status === 403,
      "a request from a foreign origin is refused (" + foreign.status + ")",
    );

    check(
      consoleErrors.length === 0,
      "no errors in the browser console" +
        (consoleErrors.length ? ": " + consoleErrors.join(" / ") : ""),
    );
    await page.close();

    // ---------------------------------------------------------------
    // 2. Not signed in (default OpenAI provider): the login screen.
    // ---------------------------------------------------------------
    const two = await startBridge(join(root, "two"), 18902, "");
    const loginPage = await context.newPage();
    await loginPage.goto(two.url);
    await loginPage.waitForSelector("#view-login:not([hidden])", {
      timeout: 30000,
    });
    check(
      await loginPage.isVisible("#login-device"),
      "without an account the Codex sign-in is shown",
    );
    check(
      !(await loginPage.isVisible("#composer-bar")),
      "the composer is hidden until signed in",
    );
    await shot(loginPage, "06-login");
    await loginPage.close();

    // ---------------------------------------------------------------
    // 3. A wrong token lands on the pairing screen.
    // ---------------------------------------------------------------
    const wrong = await context.newPage();
    await wrong.goto(
      "http://127.0.0.1:18902/#token=not-the-token-at-all-0000000",
    );
    await wrong.waitForSelector("#view-pair:not([hidden])");
    check(
      await wrong.isVisible("#pair-error"),
      "a wrong token shows the pairing screen with an error",
    );
    await shot(wrong, "07-pair");
    await wrong.close();
  } catch (error) {
    // Show what the phone showed when it went wrong, then give up.
    if (lastPage && !lastPage.isClosed()) {
      try {
        console.error("--- #messages at the time of failure ---");
        console.error(
          await lastPage
            .locator("#messages")
            .first()
            .evaluate((el) => el.innerHTML),
        );
        await shot(lastPage, "failure");
      } catch (_) {
        /* the page is gone */
      }
    }
    throw error;
  } finally {
    await browser.close();
    for (const child of children) child.kill("SIGTERM");
    if (!process.env.KEEP_E2E_DIR)
      rmSync(root, { recursive: true, force: true });
  }

  console.log(
    failures ? `\n${failures} check(s) failed` : "\nall checks passed",
  );
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  for (const child of children) child.kill("SIGTERM");
  process.exit(1);
});
