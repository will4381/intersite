// @ts-check

/**
 * Track: names user actions and stamps them on the requests they cause. Runs in the browser; no dependencies.
 *
 * @example
 * import { createTracker } from "intersite/track";
 * const tracker = createTracker({ onUi: (event) => navigator.sendBeacon("/api/ui-case", JSON.stringify(event)) });
 * const data = await tracker.fetch("/api/programs", { method: "POST", body });
 * // <button data-intersite="program.save">Save</button>
 */

import { ACTION_NAME, DOWN_MBPS, ERROR_NAME, LIST_ITEM, RTT_MS, bucket, reduceLabel, reducePage, stepProblem } from "../shared/case.mjs";
import { DEFAULT_ID_PATTERN } from "../shared/shape.mjs";

const ACTION_MS = 5000;
const SESSION_KEY = "intersite-session";
const STEP_KEY = "intersite-step";
/** Must match capture/index.mjs. */
/** What a click lands on, besides the item of a named list. */
const CLICKABLE = "a[href], button, summary, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=radio]";
/** Clicks on these are not steps: the fill that follows records the field. */
const FIELD_ROLES = ["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton"];

/**
 * @typedef {{ page: string, outcome: "ok" | "error" | "warn", session: string, name?: string, errorName?: string, step?: import("../shared/case.mjs").UiStep }} UiEvent
 * `session` is the tab's ID, for the app to pass to `recordUi` when it has no caller of its own. A step's outcome is "ok".
 */
/** @typedef {Pick<EventTarget, "addEventListener" | "removeEventListener">} Target */

/**
 * @typedef {object} TrackerOptions
 * @property {typeof fetch} [fetch]
 * @property {Target} [document]
 * @property {Target} [window]
 * @property {Pick<Location, "origin" | "href" | "pathname">} [location]
 * @property {Pick<Storage, "getItem" | "setItem">} [storage]
 * @property {(event: UiEvent) => void} [onUi]
 * @property {string[]} [origins]  Extra origins (`https://api.example.com`) whose requests get the headers.
 * @property {() => string} [page]  The current route as the router knows it (`/u/:handle`), used instead of the
 *   address bar's path. Give this when a path can hold a name or handle, which looks like any other short word.
 * @property {string} [idPattern]  The project's `capture.idPattern`, so IDs in the page path are kept.
 * @property {boolean} [steps]  Also report each page load, route change, click and filled field to `onUi`, and number
 *   the requests they cause (`x-intersite-step`), so a recorded session can become a flow.
 * @property {() => number} [now]
 */

/** The settings one tracker works from, and the action and session it remembers. @param {TrackerOptions} options */
function trackerState(options) {
  const location = options.location ?? globalThis.location;
  return {
    options,
    location,
    storage: options.storage ?? globalThis.sessionStorage,
    /** @type {typeof fetch} */
    inner: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    now: options.now ?? Date.now,
    idPattern: new RegExp(options.idPattern ?? DEFAULT_ID_PATTERN),
    origins: new Set([location.origin, ...(options.origins ?? [])]),
    /** @type {{ name: string, at: number } | undefined} */
    current: undefined,
    /** @type {string | undefined} */
    sessionId: undefined,
    /** @type {number | undefined} the tab's latest step, once steps are on */
    stepN: undefined,
    lastPath: location.pathname,
    /** When the page's navigation started or the route last changed. */
    routeAt: (options.now ?? Date.now)() - (globalThis.performance?.now() ?? 0),
  };
}

/** @typedef {ReturnType<typeof trackerState>} Tracker */

/** @param {Tracker} tracker @param {string} name */
function action(tracker, name) {
  if (ACTION_NAME.test(name)) tracker.current = { name, at: tracker.now() };
}

/** @param {Tracker} tracker */
const currentName = ({ current, now }) => (current && now() - current.at < ACTION_MS ? current.name : undefined);

/** @param {Tracker} tracker */
const page = ({ options, location, idPattern }) => reducePage(options.page?.() ?? location.pathname, (segment) => idPattern.test(segment));

/** @param {Tracker} tracker */
function session(tracker) {
  if (tracker.sessionId) return tracker.sessionId;
  // getRandomValues, not randomUUID: it also works on plain-http pages.
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    tracker.sessionId = tracker.storage.getItem(SESSION_KEY) || fresh;
    tracker.storage.setItem(SESSION_KEY, tracker.sessionId);
  } catch {
    tracker.sessionId = fresh; // storage blocked: one ID for this page load
  }
  return tracker.sessionId;
}

/** The tab's next step number, kept across reloads in the tab. @param {Tracker} tracker */
function nextStep(tracker) {
  if (tracker.stepN === undefined) {
    try {
      tracker.stepN = Number(tracker.storage.getItem(STEP_KEY)) || 0;
    } catch {
      tracker.stepN = 0; // storage blocked: count from this page load
    }
  }
  tracker.stepN++;
  try {
    tracker.storage.setItem(STEP_KEY, String(tracker.stepN));
  } catch {
    // storage blocked: the count restarts on reload, and the session ID does too
  }
  return tracker.stepN;
}

/** @param {Tracker} tracker @param {Omit<import("../shared/case.mjs").UiStep, "n">} fields @param {number} [n] */
function emitStep(tracker, fields, n = nextStep(tracker)) {
  const ms = Math.min(86_400_000, Math.max(0, Math.round((tracker.now() - tracker.routeAt) / 100) * 100));
  const step = { n, ...fields, ...(fields.kind !== "nav" && { ms }) };
  // The collector refuses a malformed step anyway; checking here saves the request.
  if (stepProblem(step, true) === undefined) tracker.options.onUi?.({ page: page(tracker), outcome: "ok", session: session(tracker), step });
}

/** A route change the app made without a page load, noticed when the next step happens or on back/forward. @param {Tracker} tracker @param {"push" | "pop"} how */
function routeChange(tracker, how) {
  if (tracker.location.pathname === tracker.lastPath) return;
  tracker.lastPath = tracker.location.pathname;
  tracker.routeAt = tracker.now();
  emitStep(tracker, { kind: "nav", how });
}

/** An element's role, explicit or implied by its tag, as far as a step needs it. @param {Element} element */
function roleOf(element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit.trim().split(/\s+/)[0];
  const tag = element.tagName;
  if (tag === "A") return "link";
  if (tag === "BUTTON" || tag === "SUMMARY") return "button";
  if (tag === "SELECT") return "combobox";
  if (tag !== "INPUT") return tag === "TEXTAREA" ? "textbox" : "generic";
  const { type } = /** @type {HTMLInputElement} */ (element);
  return ["submit", "button", "reset", "image"].includes(type) ? "button" : ["checkbox", "radio"].includes(type) ? type : "textbox";
}

/**
 * What a click was on: the nearest named element, the list item inside it, and the clickable element inside those
 * when it has no name of its own. Undefined for a click on nothing in particular, or on a form field.
 * @param {Element | null} target
 */
function clickOf(target) {
  if (!target?.closest) return undefined;
  const named = target.closest("[data-intersite]");
  let hit = target.closest(CLICKABLE);
  let item = named && target.closest(LIST_ITEM);
  if (item && (item === named || !named?.contains(item))) item = null;
  // A named element that is the clickable, or inside it, is clicked by name; a clickable row is picked by position.
  if (hit && named && hit.contains(named)) hit = null;
  if (hit && item && hit.contains(item)) hit = null;
  if (!named && !hit) return undefined;
  const role = hit ? roleOf(hit) : undefined;
  if (role && FIELD_ROLES.includes(role)) return undefined;
  const text = hit && (hit.getAttribute("aria-label") || (hit.tagName === "INPUT" ? /** @type {HTMLInputElement} */ (hit).value : hit.textContent) || "");
  // A list item's text is the user's data (a record's title), and its position already finds it.
  const label = text && !item ? reduceLabel(text) : undefined;
  const name = named?.getAttribute("data-intersite") ?? undefined;
  return {
    kind: /** @type {const} */ ("click"),
    ...(name && ACTION_NAME.test(name) && { name }),
    ...(item && named && { nth: [...named.querySelectorAll(LIST_ITEM)].indexOf(item) }),
    ...(role && { role }),
    ...(label && { label }),
  };
}

/** The connection and device, bucketed. Measured from the page's own timings, so it works where `navigator.connection` does not. */
function measureEnv() {
  const { performance: perf, navigator: nav, innerWidth, innerHeight, matchMedia } = /** @type {any} */ (globalThis);
  const rtt = roundTrip(perf, nav?.connection);
  const down = downlink(perf, nav?.connection);
  const cpu = slowdown(nav);
  return {
    ...(rtt > 0 && { rtt: bucket(rtt, RTT_MS, "up") }),
    ...(down > 0 && { down: bucket(down, DOWN_MBPS, "down") }),
    ...(cpu && { cpu }),
    ...(innerWidth > 0 && { viewport: [Math.round(innerWidth / 10) * 10, Math.round(innerHeight / 10) * 10] }),
    ...(typeof matchMedia === "function" && { mobile: matchMedia("(pointer: coarse)").matches }),
  };
}

/**
 * Milliseconds for one round trip: Chrome's estimate, else a fresh connection's TLS (or TCP) handshake, which takes
 * one, else request to first byte on a reused connection. 0 when nothing says.
 * @param {any} perf @param {any} connection @returns {number}
 */
function roundTrip(perf, connection) {
  if (connection?.rtt) return connection.rtt;
  const timing = perf?.getEntriesByType?.("navigation")?.[0];
  if (!timing) return 0;
  const handshake = timing.secureConnectionStart > 0 ? timing.connectEnd - timing.secureConnectionStart : timing.connectEnd - timing.connectStart;
  return handshake > 0 ? handshake : timing.responseStart - timing.requestStart;
}

/** The best rate, in Mbit/s, any large download on the page reached; else Chrome's estimate, which it caps at 10. @param {any} perf @param {any} connection */
function downlink(perf, connection) {
  let best = 0;
  for (const entry of perf?.getEntriesByType?.("resource") ?? []) {
    const ms = entry.responseEnd - entry.responseStart;
    if (entry.transferSize > 50_000 && ms > 0) best = Math.max(best, (entry.transferSize * 8) / ms / 1000);
  }
  return best || (connection?.downlink ?? 0);
}

/**
 * How much slower than a fast laptop the CPU likely is, or undefined when the browser does not say.
 * ponytail: guessed from cores and memory; time a long-animation-frame sample if the guess proves wrong.
 * @param {any} nav
 */
function slowdown(nav) {
  const cores = nav?.hardwareConcurrency;
  if (!cores) return undefined;
  const memory = nav.deviceMemory ?? Infinity;
  if (cores <= 2 || memory <= 1) return 6;
  if (cores <= 4 || memory <= 2) return 4;
  return cores <= 6 ? 2 : 1;
}

/** How this page was loaded, from Navigation Timing. */
function loadHow() {
  const type = /** @type {any} */ (globalThis.performance?.getEntriesByType?.("navigation")?.[0])?.type;
  return type === "reload" ? "reload" : type === "back_forward" ? "pop" : "load";
}

/** @param {Tracker} tracker @param {"error" | "warn"} outcome @param {string | undefined} name @param {unknown} [error] */
function report(tracker, outcome, name, error) {
  const { onUi } = tracker.options;
  if (!onUi) return;
  const errorName = /** @type {{ name?: unknown } | null | undefined} */ (error)?.name;
  /** @type {UiEvent} */
  const event = { page: page(tracker), outcome, session: session(tracker) };
  if (name) event.name = name;
  if (typeof errorName === "string" && ERROR_NAME.test(errorName)) event.errorName = errorName;
  onUi(event);
}

/** @param {Tracker} tracker @param {Parameters<typeof fetch>[0]} input @param {Parameters<typeof fetch>[1]} init */
function trackedFetch(tracker, input, init) {
  let stamped = init;
  try {
    const request = input instanceof Request ? input : undefined;
    // Custom headers cross-origin would force a CORS preflight the API may reject, so only listed origins get them.
    if (tracker.origins.has(new URL(request ? request.url : String(input), tracker.location.href).origin)) {
      const headers = new Headers(init?.headers ?? request?.headers);
      const name = currentName(tracker);
      if (name) headers.set("x-intersite-action", name);
      headers.set("x-intersite-page", page(tracker));
      headers.set("x-intersite-session", session(tracker));
      if (tracker.stepN !== undefined) headers.set("x-intersite-step", String(tracker.stepN));
      stamped = { ...init, headers };
    }
  } catch {
    stamped = init; // an unparsable URL: let fetch report it as it would have
  }
  return tracker.inner(input, stamped);
}

/** @param {TrackerOptions} [options] */
export function createTracker(options = {}) {
  const doc = options.document ?? globalThis.document;
  const win = options.window ?? globalThis;
  const tracker = trackerState(options);

  /** @param {Event} event */
  const onAction = (event) => {
    const target = /** @type {Element | null} */ (event.target);
    const name = target?.closest?.("[data-intersite]")?.getAttribute("data-intersite");
    if (name) action(tracker, name);
    if (!options.steps || event.type !== "click") return;
    const click = clickOf(target);
    if (!click) return;
    routeChange(tracker, "push");
    emitStep(tracker, click);
  };
  /** @param {Event} event */
  const onChange = (event) => {
    const field = /** @type {HTMLInputElement} */ (event.target);
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(field?.tagName)) return;
    const name = field.closest("[data-intersite]")?.getAttribute("data-intersite");
    routeChange(tracker, "push");
    emitStep(tracker, { kind: "fill", field: field.name || field.id, ...(name && ACTION_NAME.test(name) && { name }) });
  };
  const onPop = () => routeChange(tracker, "pop");
  const loadStep = options.steps ? nextStep(tracker) : 0;
  // Sent once the page has loaded, so its timings are complete; numbered now, so it comes before any early click.
  const onLoad = () => emitStep(tracker, { kind: "nav", how: loadHow(), env: measureEnv() }, loadStep);
  /** @param {Event} event */
  const onError = (event) => report(tracker, "error", currentName(tracker), /** @type {ErrorEvent} */ (event).error);
  /** @param {Event} event */
  const onRejection = (event) => report(tracker, "error", currentName(tracker), /** @type {PromiseRejectionEvent} */ (event).reason);

  doc.addEventListener("click", onAction, true);
  doc.addEventListener("submit", onAction, true);
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  if (options.steps) {
    doc.addEventListener("change", onChange, true);
    win.addEventListener("popstate", onPop);
    if (/** @type {Document} */ (doc).readyState === "complete") onLoad();
    else win.addEventListener("load", onLoad, { once: true });
  }

  return {
    /** @type {typeof fetch} */
    fetch: (input, init) => trackedFetch(tracker, input, init),
    /** @param {string} name */
    action: (name) => action(tracker, name),
    /** @param {string} name A developer-written name such as `cart.empty`; anything else is dropped. */
    warn: (name) => report(tracker, "warn", ACTION_NAME.test(name) ? name : undefined),
    stop() {
      doc.removeEventListener("click", onAction, true);
      doc.removeEventListener("submit", onAction, true);
      win.removeEventListener("error", onError);
      win.removeEventListener("unhandledrejection", onRejection);
      doc.removeEventListener("change", onChange, true);
      win.removeEventListener("popstate", onPop);
      win.removeEventListener("load", onLoad);
    },
  };
}
