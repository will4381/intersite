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

import { ACTION_NAME, ERROR_NAME, reducePage } from "../shared/case.mjs";
import { DEFAULT_ID_PATTERN } from "../shared/shape.mjs";

const ACTION_MS = 5000;
const SESSION_KEY = "intersite-session";
/** Must match capture/index.mjs. */

/** @typedef {{ page: string, outcome: "error" | "warn", name?: string, errorName?: string }} UiEvent */
/** @typedef {Pick<EventTarget, "addEventListener" | "removeEventListener">} Target */

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]
 * @param {Target} [options.document]
 * @param {Target} [options.window]
 * @param {Pick<Location, "origin" | "href" | "pathname">} [options.location]
 * @param {Pick<Storage, "getItem" | "setItem">} [options.storage]
 * @param {(event: UiEvent) => void} [options.onUi]
 * @param {string[]} [options.origins]  Extra origins (`https://api.example.com`) whose requests get the headers.
 * @param {string} [options.idPattern]  The project's `capture.idPattern`, so IDs in the page path are kept.
 * @param {() => number} [options.now]
 */
export function createTracker(options = {}) {
  const doc = options.document ?? globalThis.document;
  const win = options.window ?? globalThis;
  const location = options.location ?? globalThis.location;
  const storage = options.storage ?? globalThis.sessionStorage;
  const inner = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const idPattern = new RegExp(options.idPattern ?? DEFAULT_ID_PATTERN);
  const origins = new Set([location.origin, ...(options.origins ?? [])]);
  /** @type {{ name: string, at: number } | undefined} */
  let current;
  /** @type {string | undefined} */
  let sessionId;

  /** @param {string} name */
  function action(name) {
    if (ACTION_NAME.test(name)) current = { name, at: now() };
  }

  const currentName = () => (current && now() - current.at < ACTION_MS ? current.name : undefined);

  const page = () => reducePage(location.pathname, (segment) => idPattern.test(segment));

  function session() {
    if (sessionId) return sessionId;
    // getRandomValues, not randomUUID: it also works on plain-http pages.
    const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    try {
      sessionId = storage.getItem(SESSION_KEY) || fresh;
      storage.setItem(SESSION_KEY, sessionId);
    } catch {
      sessionId = fresh; // storage blocked: one ID for this page load
    }
    return sessionId;
  }

  /** @param {Event} event */
  const onAction = (event) => {
    const target = /** @type {Element | null} */ (event.target);
    const name = target?.closest?.("[data-intersite]")?.getAttribute("data-intersite");
    if (name) action(name);
  };

  /** @param {"error" | "warn"} outcome @param {string | undefined} name @param {unknown} [error] */
  function report(outcome, name, error) {
    if (!options.onUi) return;
    const errorName = /** @type {{ name?: unknown } | null | undefined} */ (error)?.name;
    /** @type {UiEvent} */
    const event = { page: page(), outcome };
    if (name) event.name = name;
    if (typeof errorName === "string" && ERROR_NAME.test(errorName)) event.errorName = errorName;
    options.onUi(event);
  }

  /** @param {Event} event */
  const onError = (event) => report("error", currentName(), /** @type {ErrorEvent} */ (event).error);
  /** @param {Event} event */
  const onRejection = (event) => report("error", currentName(), /** @type {PromiseRejectionEvent} */ (event).reason);

  doc.addEventListener("click", onAction, true);
  doc.addEventListener("submit", onAction, true);
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);

  /** @type {typeof fetch} */
  function trackedFetch(input, init) {
    let stamped = init;
    try {
      const request = input instanceof Request ? input : undefined;
      // Custom headers cross-origin would force a CORS preflight the API may reject, so only listed origins get them.
      if (origins.has(new URL(request ? request.url : String(input), location.href).origin)) {
        const headers = new Headers(init?.headers ?? request?.headers);
        const name = currentName();
        if (name) headers.set("x-intersite-action", name);
        headers.set("x-intersite-page", page());
        headers.set("x-intersite-session", session());
        stamped = { ...init, headers };
      }
    } catch {
      stamped = init; // an unparsable URL: let fetch report it as it would have
    }
    return inner(input, stamped);
  }

  return {
    fetch: trackedFetch,
    action,
    /** @param {string} name A developer-written name such as `cart.empty`; anything else is dropped. */
    warn: (name) => report("warn", ACTION_NAME.test(name) ? name : undefined),
    stop() {
      doc.removeEventListener("click", onAction, true);
      doc.removeEventListener("submit", onAction, true);
      win.removeEventListener("error", onError);
      win.removeEventListener("unhandledrejection", onRejection);
    },
  };
}
