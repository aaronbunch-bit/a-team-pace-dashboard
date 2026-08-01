/**
 * Does index.html's main inline script survive its own top-level pass?
 *
 * Run: npm test
 *
 * The page is one ~700KB inline script. Anything that throws during the initial
 * top-level pass stops the rest of the file, so every listener declared below
 * the throw is never attached. The page still renders (the markup is already
 * parsed), so it looks like a CSS or data problem rather than dead JavaScript.
 *
 * That is exactly what shipped once. An early
 *
 *   (function initLayout(){ applyLayout(...) })()
 *     -> syncRoleChrome() -> syncOpsMonthToggleUI() -> reads `opsMonthMode`
 *
 * read a `let` declared ~7,500 lines further down, hit the temporal dead zone,
 * and threw `ReferenceError: Cannot access 'opsMonthMode' before
 * initialization`. Everything after it stopped running — including
 *
 *   const googleLoginBtn = document.getElementById('googleLoginBtn');
 *   if (googleLoginBtn) googleLoginBtn.addEventListener('click', startGoogleLogin);
 *
 * so "Continue with Google" became a dead link. `node --check` cannot catch it
 * (the syntax is valid) and no unit test on the Netlify functions goes near it.
 *
 * This runs the real script in a stub DOM where every lookup succeeds, so the
 * only thing that can fail is the JavaScript itself. Nothing here asserts on
 * rendering — it asserts the script reaches the end and wires sign-in.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "..", "index.html"), "utf8");

/** The page's main inline script: the biggest <script> block without a src. */
function mainInlineScript(source) {
  let best = "";
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(source))) {
    if (/\ssrc\s*=/.test(m[1])) continue;
    if (m[2].length > best.length) best = m[2];
  }
  return best;
}

const script = mainInlineScript(html);
assert.ok(script.length > 100_000, "found the main inline script");

/** Ids the script wires listeners on — collected so we can assert on them. */
const wired = new Map();

/**
 * A DOM node that answers every question. The point is to let the script run
 * top to bottom without a real browser: any missing-element crash would be a
 * separate (and much louder) bug, while what we are hunting here is a
 * JavaScript-level throw such as a TDZ error.
 */
function makeNode(id = "") {
  const listeners = [];
  const node = {
    id,
    listeners,
    tagName: "DIV",
    className: "",
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    style: new Proxy(
      {
        setProperty() {}, removeProperty() {}, getPropertyValue: () => "",
        getPropertyPriority: () => "", item: () => "", length: 0,
      },
      { get: (t, k) => (k in t ? t[k] : ""), set: () => true }
    ),
    dataset: {},
    classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false, replace() {},
    },
    attributes: {},
    children: [],
    childNodes: [],
    firstChild: null,
    lastElementChild: null,
    parentNode: null,
    parentElement: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    isConnected: true,
    addEventListener(type) {
      listeners.push(type);
      if (id) {
        if (!wired.has(id)) wired.set(id, new Set());
        wired.get(id).add(type);
      }
    },
    removeEventListener() {},
    dispatchEvent: () => true,
    appendChild: (c) => c,
    insertBefore: (c) => c,
    removeChild: (c) => c,
    replaceChild: (c) => c,
    remove() {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getClientRects: () => [],
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, animate: () => ({ finished: Promise.resolve() }),
    insertAdjacentHTML() {},
    cloneNode() { return makeNode(id); },
    select() {}, setSelectionRange() {},
    matches: () => false,
    getContext: () => null,
    submit() {}, reset() {},
    showModal() {}, close() {}, showPopover() {}, hidePopover() {},
  };
  return node;
}

/**
 * Every id that actually exists in the markup.
 *
 * getElementById has to be faithful — returning a node for ids the page does
 * not contain is what let a real crash through: the script does
 * `document.getElementById('x').addEventListener(...)` in plenty of places, and
 * a permissive stub turns a browser TypeError into a silent pass.
 */
const realIds = new Set();
for (const m of html.matchAll(/\sid\s*=\s*"([^"]+)"/g)) realIds.add(m[1]);
for (const m of html.matchAll(/\sid\s*=\s*'([^']+)'/g)) realIds.add(m[1]);

const nodes = new Map();
const nodeFor = (id) => {
  if (!realIds.has(id)) return null;
  if (!nodes.has(id)) nodes.set(id, makeNode(id));
  return nodes.get(id);
};

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

/**
 * Writes to <body>.textContent / innerHTML delete the whole page.
 *
 * Shipped once: an attribute selector matched <body> as well as the buttons it
 * meant to match, and the loop assigned textContent — so the entire document
 * became one word. Record it here instead of letting it pass.
 */
const bodyWipes = [];
const bodyNode = makeNode("body");
for (const prop of ["textContent", "innerHTML", "innerText"]) {
  let stored = "";
  Object.defineProperty(bodyNode, prop, {
    configurable: true,
    get: () => stored,
    set(v) {
      stored = v;
      bodyWipes.push(`document.body.${prop} = ${JSON.stringify(String(v).slice(0, 60))}`);
    },
  });
}

const documentStub = {
  readyState: "loading",
  title: "",
  cookie: "",
  hidden: false,
  visibilityState: "visible",
  documentElement: makeNode("html"),
  head: makeNode("head"),
  body: bodyNode,
  currentScript: makeNode(),
  getElementById: (id) => nodeFor(String(id)),
  querySelector: () => makeNode(),
  querySelectorAll: () => [],
  getElementsByClassName: () => [],
  getElementsByTagName: () => [],
  createElement: () => makeNode(),
  createElementNS: () => makeNode(),
  createTextNode: () => makeNode(),
  createDocumentFragment: () => makeNode(),
  createRange: () => ({
    selectNodeContents() {}, setStart() {}, setEnd() {}, collapse() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  }),
  addEventListener(type) {
    if (!wired.has("document")) wired.set("document", new Set());
    wired.get("document").add(type);
  },
  removeEventListener() {},
  dispatchEvent: () => true,
  execCommand: () => true,
  hasFocus: () => true,
  elementFromPoint: () => null,
  getSelection: () => ({ removeAllRanges() {}, addRange() {}, toString: () => "" }),
};

const errors = [];
const windowStub = {
  document: documentStub,
  location: {
    href: "https://a-team-autopacer.netlify.app/",
    origin: "https://a-team-autopacer.netlify.app",
    hostname: "a-team-autopacer.netlify.app",
    protocol: "https:",
    pathname: "/",
    search: "",
    hash: "",
    host: "a-team-autopacer.netlify.app",
    assign() {}, replace() {}, reload() {},
  },
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  navigator: { userAgent: "node", language: "en-US", clipboard: { writeText: () => Promise.resolve() }, onLine: true },
  history: { pushState() {}, replaceState() {}, back() {}, go() {} },
  screen: { width: 1440, height: 900 },
  innerWidth: 1440,
  innerHeight: 900,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 1,
  matchMedia: () => ({
    matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }),
  addEventListener(type) {
    if (!wired.has("window")) wired.set("window", new Set());
    wired.get("window").add(type);
  },
  removeEventListener() {},
  dispatchEvent: () => true,
  // Timers never actually run: this test is about the top-level pass only.
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  requestIdleCallback: () => 0,
  fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
  alert() {}, confirm: () => true, prompt: () => null,
  getComputedStyle: () => new Proxy(
    { getPropertyValue: () => "", getPropertyPriority: () => "", item: () => "", length: 0 },
    { get: (t, k) => (k in t ? t[k] : "") }
  ),
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  performance: { now: () => 0 },
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000", getRandomValues: (a) => a },
  Image: class { set src(_v) {} addEventListener() {} },
  Audio: class { play() { return Promise.resolve(); } pause() {} addEventListener() {} },
  Notification: class { static permission = "default"; static requestPermission = () => Promise.resolve("default"); },
  netlifyIdentity: {
    on() {}, init() {}, open() {}, close() {}, logout() {},
    currentUser: () => null,
    gotrue: { clearSession() {} },
  },
  Chart: class { constructor() {} update() {} destroy() {} },
  __ensureChartJs: () => Promise.resolve(),
  console,
  URL,
  URLSearchParams,
  Intl,
  JSON,
  Math,
  Date,
  Promise,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Error,
  TypeError,
  RangeError,
  Symbol,
  Proxy,
  Reflect,
  isNaN,
  isFinite,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
  btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
  atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
  structuredClone: (v) => JSON.parse(JSON.stringify(v ?? null)),
  onerror: null,
};
windowStub.window = windowStub;
windowStub.self = windowStub;
windowStub.globalThis = windowStub;
windowStub.top = windowStub;
windowStub.parent = windowStub;
windowStub.frames = windowStub;

const context = vm.createContext(windowStub, { name: "index.html inline script" });

try {
  new vm.Script(script, { filename: "index.html-inline.js" }).runInContext(context, {
    timeout: 30_000,
  });
} catch (err) {
  errors.push(err);
}

if (errors.length) {
  for (const err of errors) {
    console.error("\nThe page's top-level pass threw:\n");
    console.error(err?.stack || String(err));
    // Point at the offending source line — the stack only carries a line number.
    const line = Number(/index\.html-inline\.js:(\d+)/.exec(err?.stack || "")?.[1] || 0);
    if (line) {
      const lines = script.split("\n");
      const from = Math.max(0, line - 3);
      console.error("\nSource around inline line " + line + ":");
      lines.slice(from, line + 2).forEach((l, i) => {
        const n = from + i + 1;
        console.error(`${n === line ? ">>" : "  "} ${n}: ${l}`);
      });
    }
  }
}
assert.equal(
  errors.length,
  0,
  "index.html's inline script must complete its top-level pass without throwing"
);

// The script ran to the end. These are defined near the bottom of the file, so
// they are missing if the pass aborted early.
const mustExist = [
  "render",
  "renderClientDetail",
  "syncRoleChrome",
  "syncOpsMonthToggleUI",
  "setOpsMonthMode",
  "computeTeamCancels",
  "fetchLiveActuals",
  "startGoogleLogin",
  "boot",
];
const missing = mustExist.filter((name) => typeof context[name] !== "function");
assert.deepEqual(missing, [], `the inline script stopped before defining: ${missing.join(", ")}`);

// Sign-in is what broke, and it is wired in the last few hundred lines.
const googleClicks = wired.get("googleLoginBtn");
assert.ok(
  googleClicks && googleClicks.has("click"),
  "the Google sign-in button must get its click handler wired"
);

/**
 * The render pass, with no data loaded.
 *
 * A signed-in browser calls these after boot(); if one throws, the dashboard
 * paints nothing and the page looks blank even though the top-level pass was
 * fine. They must all survive empty caches — that is also the state every tab
 * is in for the first moment after load, and after a failed fetch.
 */
const renderPasses = [
  "syncRoleChrome",
  "syncOpsMonthToggleUI",
  "render",
  "renderClientDetail",
  "renderTeamCancelsTable",
  "renderCancelsWindowNote",
  "renderTeamPersonalGoalsTable",
  "renderTeamDetailsOverlay",
  "syncGoalsEditMonthUI",
  "renderGoalsForm",
];
const renderFailures = [];
for (const name of renderPasses) {
  const fn = context[name];
  if (typeof fn !== "function") continue;
  try {
    fn.call(context);
  } catch (err) {
    renderFailures.push({ name, err });
  }
}
if (renderFailures.length) {
  for (const { name, err } of renderFailures) {
    console.error(`\n${name}() threw with empty caches:\n`);
    console.error(err?.stack || String(err));
    const line = Number(/index\.html-inline\.js:(\d+)/.exec(err?.stack || "")?.[1] || 0);
    if (line) {
      const lines = script.split("\n");
      const from = Math.max(0, line - 4);
      console.error("\nSource around inline line " + line + ":");
      lines.slice(from, line + 3).forEach((l, i) => {
        const n = from + i + 1;
        console.error(`${n === line ? ">>" : "  "} ${n}: ${l}`);
      });
    }
  }
}
assert.deepEqual(
  renderFailures.map((f) => f.name),
  [],
  "the render pass must not throw with empty caches"
);

/**
 * The quota grid edits one month at a time.
 *
 * Team quotas were a single document with no month on it, so last month's
 * board read whatever was set today. The grid now has its own month toggle and
 * reads that month's quotas; flipping it must not throw and must not resolve
 * to the live month.
 */
assert.equal(
  typeof context.goalsForMonth,
  "function",
  "the month-scoped quota reader must exist"
);
{
  const live = context.liveMonthKey();
  assert.equal(
    context.goalsForMonth(live),
    context.loadGoals(),
    "the live month reads the live quota document"
  );
  assert.ok(
    context.goalsForMonth("2020-01"),
    "a month with nothing recorded still resolves to a usable document"
  );
  assert.equal(context.goalsEditMonthKey(), live, "the grid starts on this month");
  context.setGoalsEditMonthMode("prior");
  assert.notEqual(
    context.goalsEditMonthKey(),
    live,
    "switching the grid to last month must target last month"
  );
  context.renderGoalsForm();
  context.setGoalsEditMonthMode("current");
  assert.equal(context.goalsEditMonthKey(), live);
}

if (bodyWipes.length) {
  console.error("\nSomething wrote to <body> in a way that deletes the page:\n");
  bodyWipes.forEach((w) => console.error("  " + w));
}
assert.deepEqual(bodyWipes, [], "nothing may assign textContent/innerHTML on <body>");

// A toggle that is `hidden` in the markup must stay hidden: a CSS `display`
// on the same element beats the attribute, which is how an ops-only control
// ended up as the only visible thing on a blank page.
const css = readFileSync(resolve(here, "..", "assets", "app.css"), "utf8");
for (const cls of ["ops-month-toggle"]) {
  const rule = new RegExp(`\\.${cls}\\s*\\{[^}]*display\\s*:`, "m");
  if (rule.test(css)) {
    assert.ok(
      new RegExp(`\\.${cls}\\[hidden\\]|\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`, "m").test(css),
      `.${cls} sets display, so it needs a [hidden] rule or it renders while hidden`
    );
  }
}

console.log(
  `ok — index.html top-level pass completes (${script.split("\n").length} lines), ` +
    "Google sign-in wired, render pass survives empty caches, quota grid switches month"
);
