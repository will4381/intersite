// @ts-check
// Code rules for the react-native pack: import each rule module here and list it.
import * as noAnimatedLayoutKey from "./no-animated-layout-key.mjs";
import * as noStatePerScrollEvent from "./no-state-per-scroll-event.mjs";

/** @type {{ id: string, pack: string, rule: unknown, bad: string[], good: string[], ext?: string }[]} */
export default [noAnimatedLayoutKey, noStatePerScrollEvent];
