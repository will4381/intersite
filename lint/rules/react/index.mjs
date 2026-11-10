// @ts-check
// Code rules for the react area: import each rule module here and list it.
import * as noDerivedStateEffect from "./no-derived-state-effect.mjs";
import * as noIndexKeyOnChangingList from "./no-index-key-on-changing-list.mjs";
import * as noNestedComponent from "./no-nested-component.mjs";
import * as noNeedlessUseClient from "./no-needless-use-client.mjs";
import * as noPointlessMemo from "./no-pointless-memo.mjs";
import * as noRacyEffectFetch from "./no-racy-effect-fetch.mjs";
import * as noStateSprawl from "./no-state-sprawl.mjs";
import * as noUnstableDefaultDependency from "./no-unstable-default-dependency.mjs";

/** @type {{ id: string, pack: string, rule: unknown, bad: string[], good: string[], ext?: string }[]} */
export default [noDerivedStateEffect, noIndexKeyOnChangingList, noNeedlessUseClient, noNestedComponent, noPointlessMemo, noRacyEffectFetch, noStateSprawl, noUnstableDefaultDependency];
