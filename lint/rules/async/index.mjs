// @ts-check
// Code rules for the async area: import each rule module here and list it.
import * as noDroppedError from "./no-dropped-error.mjs";
import * as noFixedSleep from "./no-fixed-sleep.mjs";
import * as noHandRolledBackoff from "./no-hand-rolled-backoff.mjs";
import * as requireFetchOk from "./require-fetch-ok.mjs";

/** @type {{ id: string, pack: string, rule: unknown, bad: string[], good: string[] }[]} */
export default [noDroppedError, noFixedSleep, noHandRolledBackoff, requireFetchOk];
