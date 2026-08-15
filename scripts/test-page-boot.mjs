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

/**
 * Attributions in the Individual Pacer must bucket by Central saleDate — the
 * same key approved-totals uses — so August credits show on August pacers.
 */
assert.equal(typeof context.attrMonthKey, "function", "attrMonthKey must exist");
assert.equal(
  context.attrMonthKey({
    saleDate: "2026-08-01",
    submittedAt: "2026-08-01T14:00:00.000Z",
  }),
  "2026-08"
);
assert.equal(
  context.attrMonthKey({
    saleDate: "2026-07-31",
    submittedAt: "2026-08-01T02:15:00.000Z",
  }),
  "2026-07",
  "UTC midnight must not pull a Central July sale into August's list"
);

/**
 * Pending and Actioned Manual Attribution queues start on the current Central
 * month. Both still offer All time, and a refresh preserves a user's choice.
 */
assert.equal(typeof context.populateAttrMonthFilter, "function", "month filter population must exist");
{
  const current = context.teamTodayMonthKey();
  const pendingMonth = documentStub.getElementById("attrPendingMonthFilter");
  const actionedMonth = documentStub.getElementById("attrMonthFilter");
  context.populateAttrMonthFilter([
    { saleDate: `${current}-01` },
    { saleDate: "2020-01-15" },
  ]);
  assert.equal(pendingMonth.value, current, "Pending defaults to the current month");
  assert.equal(actionedMonth.value, current, "Actioned defaults to the current month");
  assert.match(pendingMonth.innerHTML, /value="all"/, "Pending still offers All time");
  assert.match(actionedMonth.innerHTML, /value="all"/, "Actioned still offers All time");

  pendingMonth.value = "all";
  actionedMonth.value = "all";
  context.populateAttrMonthFilter([{ saleDate: `${current}-02` }]);
  assert.equal(pendingMonth.value, "all", "Pending preserves an explicit All time choice");
  assert.equal(actionedMonth.value, "all", "Actioned preserves an explicit All time choice");
}

/**
 * Compact live polls must never blank the Individual Pacer's line items.
 *
 * Background polls ask for `compact=1` (totals only, no per-sale rows) and
 * sibling tabs share that same compact document. Applying one of those over the
 * cache used to replace the full rep rows wholesale, so Activity kept showing
 * correct Members/Sessions totals above an "No attributions" table until the
 * next full poll — or forever, in a tab that never won poll leadership.
 */
assert.equal(typeof context.applyLiveActualsPayload, "function", "applyLiveActualsPayload must exist");
assert.equal(typeof context.actualsCarryItems, "function", "actualsCarryItems must exist");
{
  const month = context.liveMonthKey();
  const asOf = `${month}-15`;
  const full = {
    viewMonth: month,
    actuals: {
      asOf,
      perRep: {
        "Becky Ruffer": {
          members: 3,
          sessions: 20,
          membersCancels: 0,
          sessionsCancels: 0,
          items: [
            { clientId: "111", members: 2, sessions: 12, date: asOf },
            { clientId: "222", members: 1, sessions: 8, date: asOf },
          ],
        },
      },
    },
  };
  const compact = {
    viewMonth: month,
    actuals: {
      asOf,
      perRep: {
        "Becky Ruffer": { members: 4, sessions: 24, membersCancels: 0, sessionsCancels: 0 },
      },
    },
  };

  assert.ok(context.actualsCarryItems(full.actuals), "a full payload carries line items");
  assert.ok(!context.actualsCarryItems(compact.actuals), "a compact payload carries none");

  context.applyLiveActualsPayload(full, true, "");
  assert.equal(
    context.loadActuals().perRep["Becky Ruffer"].items.length,
    2,
    "a full payload loads the line items"
  );

  // The compact poll's own path, and the sibling-share path that passed
  // wantFull=true with an items-less document.
  for (const wantFull of [false, true]) {
    context.applyLiveActualsPayload(compact, wantFull, "");
    const row = context.loadActuals().perRep["Becky Ruffer"];
    assert.equal(row.members, 4, "compact totals still apply");
    assert.equal(
      row.items.length,
      2,
      `a compact payload must keep the cached line items (wantFull=${wantFull})`
    );
  }

  // A rep the payload knows nothing about gets an empty list, never undefined:
  // the Activity tables read `.items` directly.
  context.applyLiveActualsPayload(
    {
      viewMonth: month,
      actuals: { asOf, perRep: { "New Hire": { members: 0, sessions: 0 } } },
    },
    false,
    ""
  );
  const newHire = context.loadActuals().perRep["New Hire"];
  assert.ok(Array.isArray(newHire.items), "an unknown rep still gets an items array");
  assert.equal(newHire.items.length, 0, "an unknown rep gets an empty item list");
}

/**
 * A failed live feed must retry, and must never leave the board reading zeros.
 *
 * The failure this covers was a 500 returned by the platform in ~80ms, before
 * the function's own error handling ran, so the body was plain text with no
 * `error` field in it. Three things went wrong at once: the dashboard reported
 * only "Request failed (500)" because it parsed the body as JSON and threw the
 * text away, one bad response was accepted as final until the next poll 90
 * seconds later, and the Blobs/CSV fallback it fell back to is empty for a month
 * whose only writer is this feed — so every rep read 0.0% and every board said
 * "No data yet".
 */
{
  const month = context.liveMonthKey();
  const asOf = `${month}-14`;

  const res = (status, body, contentType, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        if (key === "content-type") return contentType;
        return headers[key] ?? null;
      },
    },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  });
  const crash = (headers) =>
    res(500, "Runtime.ImportModuleError: Cannot find module 'x'", "text/plain", headers);
  const feed = (perRep) =>
    res(200, JSON.stringify({ viewMonth: month, actuals: { asOf, perRep } }), "application/json");

  // The harness's timers never fire, and the retry helper awaits one.
  const originalSetTimeout = context.setTimeout;
  const originalFetch = context.fetch;
  const originalCurrentUser = context.netlifyIdentity.currentUser;
  context.setTimeout = (fn) => { Promise.resolve().then(fn); return 0; };
  context.netlifyIdentity.currentUser = () => ({ jwt: () => Promise.resolve("test-token") });

  try {
    assert.equal(typeof context.fetchLiveActualsWithRetry, "function", "the retry helper must exist");

    // A crashed function returns no `error` field, so the status, the body text
    // and Netlify's request id are all the report there is. Throwing them away
    // is why this took three rounds of back-and-forth to place.
    context.fetch = () => Promise.resolve(crash({ "x-nf-request-id": "01M00JJ1JSNA7" }));
    await assert.rejects(
      () => context.authedFetch("/api/actuals/live"),
      (err) => {
        assert.match(err.message, /Runtime\.ImportModuleError/, "keeps a non-JSON body");
        assert.match(err.message, /\(500\)/, "names the status");
        assert.match(err.message, /01M00JJ1JSNA7/, "quotes the request id");
        assert.equal(err.status, 500);
        return true;
      }
    );

    // Two bad instances then a good one: the poll recovers on its own.
    let calls = 0;
    context.fetch = () => {
      calls += 1;
      if (calls < 3) return Promise.resolve(crash());
      return Promise.resolve(feed({ "Becky Ruffer": { members: 2, sessions: 9 } }));
    };
    let recovered = null;
    let recoverErr = null;
    try {
      recovered = await context.fetchLiveActualsWithRetry("/api/actuals/live?compact=1", {
        acceptNotModified: true,
      });
    } catch (err) {
      recoverErr = err;
    }
    assert.equal(
      recoverErr,
      null,
      `a 5xx must be retried, not accepted as final — got ${recoverErr && recoverErr.message}`
    );
    assert.equal(calls, 3, "and it retries until an instance answers");
    assert.equal(recovered.actuals.perRep["Becky Ruffer"].members, 2);

    // A 4xx is an answer, not a hiccup — retrying a signed-out session just
    // delays the sign-in prompt.
    calls = 0;
    context.fetch = () => {
      calls += 1;
      return Promise.resolve(res(401, JSON.stringify({ error: "Sign in required" }), "application/json"));
    };
    await assert.rejects(
      () => context.fetchLiveActualsWithRetry("/api/actuals/live"),
      /Sign in required/
    );
    assert.equal(calls, 1, "a 401 must not be retried");

    // The retry is not special to live actuals — every GET gets it, which is
    // what stops a single transient 500 on /api/dashboard/data from dropping the
    // reps who only exist in the live roster (the "Amanda/Nicki/Michele/Jordan
    // are missing" report: the client fell back to the 9 baked-in defaults).
    calls = 0;
    context.fetch = () => {
      calls += 1;
      if (calls < 2) return Promise.resolve(crash());
      return Promise.resolve(res(200, JSON.stringify({ roster: ["everyone"] }), "application/json"));
    };
    const dash = await context.authedFetch("/api/dashboard/data", { cache: "no-store" });
    assert.equal(calls, 2, "a GET read retries a transient 500");
    assert.deepEqual(dash.roster, ["everyone"], "and returns the real data once an instance answers");

    // A write must NOT be replayed by default — a committed POST that failed to
    // respond could double-write.
    calls = 0;
    context.fetch = () => { calls += 1; return Promise.resolve(crash()); };
    await assert.rejects(
      () => context.authedFetch("/api/thing", { method: "POST", body: "{}" }),
      /Runtime\.ImportModuleError/
    );
    assert.equal(calls, 1, "a POST is not retried unless the caller opts in");

    // ...unless it opts in. Attribution submit does, because the server rejects
    // real duplicates and an init-level 500 wrote nothing — so a rep does not
    // have to retype the whole request over one blip.
    calls = 0;
    context.fetch = () => {
      calls += 1;
      if (calls < 3) return Promise.resolve(crash());
      return Promise.resolve(res(200, JSON.stringify({ record: { id: "attr1" } }), "application/json"));
    };
    const submitted = await context.authedFetch("/api/attributions/submit", {
      method: "POST",
      body: "{}",
      retry: true,
    });
    assert.equal(calls, 3, "an opted-in write retries transient failures");
    assert.equal(submitted.record.id, "attr1");

    // The salvage path: the feed is down for every attempt, but this browser
    // already holds real numbers for this month, so they stay on screen.
    assert.equal(typeof context.actualsHaveLiveMonthNumbers, "function");
    context.localStorage.setItem(
      "pace_live_actuals_share_v1",
      JSON.stringify({
        fetchedAtMs: Date.now() - 20 * 60_000,
        viewMonth: month,
        hasItems: true,
        actuals: {
          asOf,
          perRep: {
            "Becky Ruffer": {
              members: 5,
              sessions: 31,
              membersCancels: 0,
              sessionsCancels: 0,
              items: [{ clientId: "8561610", members: 5, sessions: 31, date: asOf }],
            },
          },
        },
      })
    );
    // Start from nothing, the way a page load that fails its first fetch does.
    context.applyLiveActualsPayload({ viewMonth: month, actuals: { asOf, perRep: {} } }, true, "");
    assert.ok(!context.actualsHaveLiveMonthNumbers(), "starting with an empty month");

    context.fetch = () => Promise.resolve(crash());
    const status = documentStub.getElementById("liveActualsStatus");
    await context.fetchLiveActuals({ full: true });

    assert.equal(
      context.loadActuals().perRep["Becky Ruffer"]?.members,
      5,
      "a failed load must fall back to the last numbers this browser had, not zeros"
    );
    assert.ok(context.actualsHaveLiveMonthNumbers(), "the board is no longer blank");
    assert.match(
      status.textContent,
      /last numbers that loaded/,
      "and it must say the numbers are not current"
    );
    assert.match(status.textContent, /20 min ago/, "with their age, so nobody reads them as live");

    // Salvaged numbers are real but stale: nothing may badge them as live.
    assert.equal(context.lastLiveActualsOk, undefined, "lastLiveActualsOk is script-local");
    assert.doesNotMatch(status.textContent, /feed OK/, "a stale read is not a healthy sync");

    // Stale data must never cross a month boundary.
    context.localStorage.setItem(
      "pace_live_actuals_share_v1",
      JSON.stringify({
        fetchedAtMs: Date.now(),
        viewMonth: "2020-01",
        actuals: { asOf: "2020-01-15", perRep: { "Becky Ruffer": { members: 99, sessions: 99 } } },
      })
    );
    context.applyLiveActualsPayload({ viewMonth: month, actuals: { asOf, perRep: {} } }, true, "");
    await context.fetchLiveActuals({ full: true });
    assert.notEqual(
      context.loadActuals().perRep["Becky Ruffer"]?.members,
      99,
      "another month's share must never be salvaged onto this month's pacer"
    );
  } finally {
    context.setTimeout = originalSetTimeout;
    context.fetch = originalFetch;
    context.netlifyIdentity.currentUser = originalCurrentUser;
    context.localStorage.removeItem("pace_live_actuals_share_v1");
  }
}

/**
 * A sign-in the app cannot confirm must not destroy the session.
 *
 * Chris's Identity log showed the same four events every time, inside one minute:
 * logged in, refreshed token, revoked token, logged out — and then nothing, ever.
 * `resolveIdentityEmail` returned `''` whenever its lookup failed, `''` does not
 * end in the company domain, so the app took the wrong-account branch and wiped
 * the session. `clearGoTrueStorage` took the refresh token with it, so there was
 * nothing left to refresh and every reload repeated it.
 *
 * Not every Identity record carries the address inline, so for some people that
 * network lookup runs on every single sign-in. One blip was enough to lock them
 * out until somebody re-authorised through Google.
 */
{
  assert.equal(typeof context.acceptIdentityUser, "function", "the login gate must exist");
  assert.equal(typeof context.resolveIdentityEmail, "function");

  const originalFetch = context.fetch;
  const originalSetTimeout = context.setTimeout;
  // The harness's timers never fire, and the retries await one.
  context.setTimeout = (fn) => { Promise.resolve().then(fn); return 0; };

  // Identity is provisioned and Google is on — the state a real browser is in.
  // Otherwise the gate short-circuits on an earlier branch and this proves nothing.
  assert.equal(typeof context.applyIdentityBackendDiagnosis, "function");
  context.applyIdentityBackendDiagnosis({ status: "ready", settings: { external: { google: true } } });

  const revoked = [];
  context.netlifyIdentity.logout = () => { revoked.push("logout"); return Promise.resolve(); };
  const gateError = () => documentStub.getElementById("loginGateError").textContent;

  // The shared stub's classList is a no-op, so "did the dashboard open?" needs a
  // real one here or the assertion measures nothing.
  const stubClassList = documentStub.body.classList;
  const classes = new Set();
  documentStub.body.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (on ? classes.add(c) : classes.delete(c))),
    contains: (c) => classes.has(c),
    replace: () => {},
  };
  const appIsOpen = () => classes.has("app-ready");

  // A user record with no inline address is the shape that forces the fallbacks.
  const noInlineEmail = { jwt: () => Promise.resolve("h.e30.s"), user_metadata: {}, app_metadata: {} };
  const jsonRes = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });

  try {
    // 1. Identity unreachable. The session must survive.
    context.localStorage.setItem("gotrue.user", "session-token");
    revoked.length = 0;
    context.fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    await context.acceptIdentityUser(noInlineEmail);
    assert.deepEqual(revoked, [], "an unreadable address must not revoke the token");
    assert.equal(
      context.localStorage.getItem("gotrue.user"),
      "session-token",
      "and must not wipe the refresh token — that is what made it unrecoverable"
    );
    assert.match(gateError(), /usually temporary/, "the message must not blame the account");
    assert.match(
      gateError(),
      /do not need to clear/i,
      "and must say so, since clearing the browser is exactly what this cost people"
    );

    // 2. A transient blip must heal itself rather than needing a person.
    revoked.length = 0;
    let calls = 0;
    context.fetch = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
      return jsonRes(200, { email: "christopher.jones@varsitytutors.com" });
    };
    await context.acceptIdentityUser(noInlineEmail);
    assert.ok(calls >= 2, "the lookup is retried");
    assert.deepEqual(revoked, [], "a retry that succeeds must not have revoked anything");
    assert.ok(appIsOpen(), "and the dashboard opens once the address is confirmed");

    // 3. A genuinely wrong account is still refused, and cleared.
    revoked.length = 0;
    context.localStorage.setItem("gotrue.user", "session-token");
    context.fetch = () => jsonRes(200, { email: "chris@gmail.com" });
    await context.acceptIdentityUser(noInlineEmail);
    assert.deepEqual(revoked, ["logout"], "an outside address must still be signed out");
    assert.equal(
      context.localStorage.getItem("gotrue.user"),
      null,
      "and its session cleared"
    );
    assert.match(gateError(), /chris@gmail\.com/, "naming the address that was refused");

    // 4. A 401 is a finished session, not a blip: say so, and stop retrying.
    revoked.length = 0;
    calls = 0;
    context.fetch = () => { calls += 1; return jsonRes(401, {}); };
    await context.acceptIdentityUser(noInlineEmail);
    assert.equal(calls, 1, "a 401 must not be retried");
    assert.match(gateError(), /expired/i, "and must read as an expired session");

    // 5. The normal case: an inline address needs no network at all.
    revoked.length = 0;
    context.fetch = () => Promise.reject(new Error("must not be called"));
    await context.acceptIdentityUser({ email: "becky.ruffer@varsitytutors.com" });
    assert.ok(appIsOpen(), "an inline company address opens the dashboard without a lookup");
    assert.deepEqual(revoked, []);
  } finally {
    context.fetch = originalFetch;
    context.setTimeout = originalSetTimeout;
    documentStub.body.classList = stubClassList;
    context.localStorage.removeItem("gotrue.user");
  }
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
    "Google sign-in wired, render pass survives empty caches, quota grid switches month, " +
    "compact polls keep pacer line items"
);
