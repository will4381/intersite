// Types for TypeScript projects. The JSDoc in index.mjs is the source; test/types.test.mjs fails when an export is missing here.

export interface UiEvent { page: string; outcome: "error" | "warn"; name?: string; errorName?: string }
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
