/**
 * Load index.html in real Chrome and assert the page actually renders.
 *
 * Run: npm run test:browser        (needs: npm run test:browser:install once)
 *
 * The stub-DOM test (test-page-boot.mjs) proves the script completes its
 * top-level pass. It cannot prove the page still *exists* afterwards, and that
 * is the failure that reached production twice:
 *
 *   1. A TDZ ReferenceError stopped the script partway, so the Google sign-in
 *      handler was never attached — the login screen rendered but the button
 *      was dead.
 *   2. `syncOpsMonthToggleUI` set `data-ops-month` on <body>, then matched
 *      `document.querySelectorAll('[data-ops-month]')` — which now included
 *      <body> — and assigned `btn.textContent`. Writing textContent on <body>
 *      deletes every child, so the whole page became the single word
 *      "This month". Bug 1 had been masking bug 2 by throwing first.
 *
 * Both are invisible to a syntax check and to a stub DOM. Both are obvious the
 * moment a browser parses the file, which is all this does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log(
    "SKIPPED — playwright is not installed. Run `npm run test:browser:install` to enable this test."
  );
  process.exit(0);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(String(req.url).split("?")[0]);
    if (path === "/") path = "/index.html";
    const buf = await readFile(join(root, path));
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    // The page calls /api/* and third-party scripts; a 404 is the honest answer
    // and the page is expected to survive it.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found in test server"}');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();

const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.stack || err.message));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(1500);

const state = await page.evaluate(() => {
  const vis = (el) => {
    if (!el) return "missing";
    const s = getComputedStyle(el);
    return `${s.display}/${s.visibility}`;
  };
  return {
    bodyChildren: document.body.children.length,
    bodyText: (document.body.innerText || "").trim(),
    loginGate: vis(document.getElementById("loginGate")),
    googleBtn: vis(document.getElementById("googleLoginBtn")),
    wrap: vis(document.querySelector(".wrap")),
    opsToggle: vis(document.getElementById("opsMonthToggle")),
    monthButtons: document.querySelectorAll("button.ops-month-btn[data-ops-month]").length,
    // A bare [data-ops-month] selector must never reach <body>: that is what
    // let a textContent write wipe the document.
    bareSelectorHitsBody: [...document.querySelectorAll("[data-ops-month]")].some(
      (el) => el === document.body || el.tagName === "BODY"
    ),
  };
});

await browser.close();
server.close();

if (pageErrors.length) {
  console.error("\nUncaught errors while loading the page:\n");
  pageErrors.forEach((e) => console.error(e.split("\n").slice(0, 6).join("\n") + "\n"));
}
assert.deepEqual(pageErrors, [], "the page must load with no uncaught JavaScript errors");

// The document has to survive its own scripts. One child means something
// replaced the body.
assert.ok(
  state.bodyChildren > 10,
  `body should still hold the page (got ${state.bodyChildren} children, text: ${JSON.stringify(state.bodyText.slice(0, 80))})`
);

// Signed out is the state a cold load lands in: the gate and its button must be
// on screen and clickable.
assert.notEqual(state.loginGate, "missing", "the login gate must exist");
assert.ok(!state.loginGate.startsWith("none"), `login gate must be visible (got ${state.loginGate})`);
assert.notEqual(state.googleBtn, "missing", "the Google sign-in button must exist");
assert.ok(
  !state.googleBtn.startsWith("none"),
  `the Google sign-in button must be visible (got ${state.googleBtn})`
);
assert.ok(
  /sign in|continue with google/i.test(state.bodyText),
  `the login screen must render its copy (got ${JSON.stringify(state.bodyText.slice(0, 120))})`
);

// The ops-only month toggle ships `hidden` and must stay hidden for a signed-out
// visitor — a CSS `display` on the element beats the attribute.
assert.ok(
  state.opsToggle === "missing" || state.opsToggle.startsWith("none"),
  `the month toggle must stay hidden when not signed in (got ${state.opsToggle})`
);
assert.equal(state.monthButtons, 6, "all three month toggles have both buttons");
assert.equal(
  state.bareSelectorHitsBody,
  false,
  "[data-ops-month] must not match <body> — writing to those nodes wipes the page"
);

console.log(
  `ok — real Chrome renders the login screen, no page errors, ${state.bodyChildren} body children, ops toggle hidden`
);
