// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTracker } from "../../track/index.mjs";

/** An event target that records its listeners. */
function target() {
  /** @type {{ type: string, listener: Function, capture: boolean }[]} */
  const listeners = [];
  return {
    listeners,
    /** @param {string} type @param {Function} listener @param {boolean} [capture] */
    addEventListener(type, listener, capture = false) { listeners.push({ type, listener, capture }); },
    /** @param {string} type @param {Function} listener @param {boolean} [capture] */
    removeEventListener(type, listener, capture = false) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.listener === listener && entry.capture === capture);
      if (index >= 0) listeners.splice(index, 1);
    },
    /** @param {string} type @param {object} event */
    dispatch(type, event) { for (const entry of listeners.filter((item) => item.type === type)) entry.listener(event); },
  };
}

/** A DOM element just big enough for `closest("[data-intersite]")`. @param {string | null} action @param {any} [parent] @returns {any} */
function element(action, parent = null) {
  return {
    parent,
    getAttribute: () => action,
    closest() {
      let node = this;
      while (node && node.getAttribute() === null) node = node.parent;
      return node;
    },
  };
}

function setup(/** @type {object} */ extra = {}) {
  const document = target();
  const window = target();
  /** @type {Map<string, string>} */
  const stored = new Map();
  const storage = { getItem: (/** @type {string} */ key) => stored.get(key) ?? null, setItem: (/** @type {string} */ key, /** @type {string} */ value) => void stored.set(key, value) };
  /** @type {{ input: unknown, init: RequestInit | undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response("ok");
  };
  /** @type {object[]} */
  const ui = [];
  const clock = { now: 1_000_000 };
  const location = { origin: "https://app.test", href: "https://app.test/programs/prog_8fK2abQ9/alice@example.com", pathname: "/programs/prog_8fK2abQ9/alice@example.com" };
  const tracker = createTracker({ document, window, storage, fetch, location, now: () => clock.now, onUi: (event) => void ui.push(event), ...extra });
  /** @param {number} index */
  const headers = (index) => new Headers(calls[index].init?.headers);
  return { document, window, stored, calls, ui, clock, tracker, headers };
}

test("a click inside a named element stamps the next same-origin fetch", async () => {
  const { document, tracker, headers, stored } = setup();
  const button = element("program.save");
  document.dispatch("click", { target: element(null, element(null, button)) });
  await tracker.fetch("/api/programs", { method: "POST", headers: { "content-type": "application/json" } });
  assert.equal(headers(0).get("x-intersite-action"), "program.save");
  assert.equal(headers(0).get("x-intersite-page"), "/programs/prog_8fK2abQ9/_");
  assert.equal(headers(0).get("content-type"), "application/json");
  assert.match(headers(0).get("x-intersite-session") ?? "", /^[0-9a-f]{32}$/);
  assert.equal(stored.get("intersite-session"), headers(0).get("x-intersite-session"));

  document.dispatch("submit", { target: element("program.create") });
  await tracker.fetch(new Request("https://app.test/api/programs"));
  assert.equal(headers(1).get("x-intersite-action"), "program.create");
  assert.equal(headers(1).get("x-intersite-session"), headers(0).get("x-intersite-session"), "session is stable");
});

test("cross-origin requests get no headers unless their origin is listed", async () => {
  const { tracker, calls, headers } = setup({ origins: ["https://api.test"] });
  tracker.action("program.save");
  await tracker.fetch("https://elsewhere.test/x", { method: "GET" });
  await tracker.fetch("https://api.test/x");
  assert.deepEqual(calls[0].init, { method: "GET" });
  assert.equal(headers(1).get("x-intersite-action"), "program.save");
});

test("the action expires after 5 seconds, and an invalid name is ignored", async () => {
  const { document, tracker, clock, headers } = setup();
  tracker.action("program.save");
  clock.now += 4999;
  await tracker.fetch("/a");
  clock.now += 1;
  await tracker.fetch("/b");
  assert.equal(headers(0).get("x-intersite-action"), "program.save");
  assert.equal(headers(1).get("x-intersite-action"), null);
  assert.equal(headers(1).get("x-intersite-page"), "/programs/prog_8fK2abQ9/_", "page and session are still sent");

  tracker.action("program.save");
  tracker.action("Save Program!");
  document.dispatch("click", { target: element("Delete <b>everything</b>") });
  await tracker.fetch("/c");
  assert.equal(headers(2).get("x-intersite-action"), "program.save");
});

test("errors and warnings reach onUi with the error name only", () => {
  const { window, tracker, ui } = setup();
  tracker.action("program.save");
  window.dispatch("error", { error: new TypeError("Cannot read alice@example.com") });
  window.dispatch("unhandledrejection", { reason: "a string with no name" });
  tracker.warn("cart.empty");
  tracker.warn("Free text from the page");
  assert.deepEqual(ui, [
    { page: "/programs/prog_8fK2abQ9/_", outcome: "error", name: "program.save", errorName: "TypeError" },
    { page: "/programs/prog_8fK2abQ9/_", outcome: "error", name: "program.save" },
    { page: "/programs/prog_8fK2abQ9/_", outcome: "warn", name: "cart.empty" },
    { page: "/programs/prog_8fK2abQ9/_", outcome: "warn" },
  ]);
  assert.ok(!JSON.stringify(ui).includes("Cannot read"));
});

test("stop() removes every listener", () => {
  const { document, window, tracker } = setup();
  assert.deepEqual(document.listeners.map((entry) => [entry.type, entry.capture]), [["click", true], ["submit", true]]);
  assert.deepEqual(window.listeners.map((entry) => entry.type), ["error", "unhandledrejection"]);
  tracker.stop();
  assert.equal(document.listeners.length + window.listeners.length, 0);
});

test("a route template from the app replaces the address bar's path, so a name in the URL is never sent", async () => {
  const { tracker, headers } = setup({ page: () => "/u/:handle/posts" });
  await tracker.fetch("https://app.test/api/x");
  assert.equal(headers(0).get("x-intersite-page"), "/u/_/posts");
});
