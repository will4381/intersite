// Types for TypeScript projects. The JSDoc in index.mjs is the source; test/types.test.mjs fails when an export is missing here.

export interface UiStep {
  n: number;
  kind?: "nav" | "click" | "fill";
  how?: "load" | "reload" | "push" | "pop";
  name?: string;
  nth?: number;
  role?: string;
  label?: string;
  field?: string;
  ms?: number;
  env?: { rtt?: number; down?: number; cpu?: number; viewport?: [number, number]; mobile?: boolean };
}
/** `session` is the tab's ID, for `recordUi` when the app has no caller of its own. A step's outcome is "ok". */
export interface UiEvent { page: string; outcome: "ok" | "error" | "warn"; session: string; name?: string; errorName?: string; step?: UiStep }
type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface TrackerOptions {
  fetch?: typeof fetch;
  document?: Target;
  window?: Target;
  location?: Pick<Location, "origin" | "href" | "pathname">;
  storage?: Pick<Storage, "getItem" | "setItem">;
  onUi?: (event: UiEvent) => void;
  /** Extra origins (`https://api.example.com`) whose requests get the headers. */
  origins?: string[];
  /** The current route as the router knows it (`/u/:handle`). */
  page?: () => string;
  /** The project's `capture.idPattern`, so IDs in the page path are kept. */
  idPattern?: string;
  /** Also report each page load, route change, click and filled field to `onUi`, and number the requests they cause. */
  steps?: boolean;
  now?: () => number;
}

export function createTracker(options?: TrackerOptions): {
  /** `fetch` with the action, page and session headers added on requests to the app's own origins. */
  fetch: typeof fetch;
  /** Names the action in progress, for code that has no element to put `data-intersite` on. */
  action(name: string): void;
  /** Reports a warning under a developer-written name such as `cart.empty`. */
  warn(name: string): void;
  stop(): void;
};
