// Types for TypeScript projects. The JSDoc in index.mjs is the source; test/types.test.mjs fails when an export is missing here.

type Outcome = "ok" | "warn" | "rejected" | "error";
type HeaderBag = Headers | Record<string, string | string[] | number | undefined>;

export interface CaptureOptions {
  project: string;
  /** Collector base URL. */
  url: string;
  /** Ingest token. */
  token: string;
  /** A Workers service binding to use instead of global fetch. */
  fetcher?: { fetch: typeof fetch };
  release: string;
  /** Defaults to `token`. */
  salt?: string;
  sample?: number;
  maxBodyBytes?: number;
  include?: string[];
  exclude?: string[];
  /** Keys whose values are always replaced, on top of the built-in list. */
  redactKeys?: string[];
  /** Keys whose short codes and dates are kept, on top of the built-in structural and date words. */
  keepKeys?: string[];
  idPattern?: string;
  ttlDays?: Partial<Record<Outcome, number>>;
}

/** `url` may be a path; `body` is parsed JSON or a JSON string. */
export interface PlainRequest { method: string; url: string; headers?: HeaderBag; body?: unknown }
export interface PlainResponse { status: number; headers?: HeaderBag; body?: unknown }

export interface RecordInput {
  /** A Request clone taken before handling (body unread), or a plain object. */
  request: Request | PlainRequest;
  /** The response being returned; a Response is cloned only when sampled. */
  response: Response | PlainResponse;
  /** Route template such as `/v1/programs/:id`. */
  route: string;
  actor?: { kind: string };
  /** A stable caller identifier; only its salted daily hash is stored. */
  session?: string;
  outcome?: Outcome;
  id?: string;
  at?: string | Date;
}

export interface UiInput {
  page: string;
  name?: string;
  outcome: Outcome;
  errorName?: string;
  session?: string;
  actor?: { kind: string };
  release?: string;
}

export type Described = { route: string; actor?: { kind: string }; session?: string } | undefined;

export function createCapture(options: CaptureOptions): {
  record(input: RecordInput): Promise<void>;
  recordUi(input: UiInput): Promise<void>;
  wrapFetch(fetcher: typeof fetch, describe: (request: Request) => Described): typeof fetch;
};
