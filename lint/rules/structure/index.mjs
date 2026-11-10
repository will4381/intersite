// @ts-check
// Code rules for the structure area: import each rule module here and list it.
import * as noAliasModule from "./no-alias-module.mjs";
import * as maxFunctionStatements from "./max-function-statements.mjs";
import * as maxNestingDepth from "./max-nesting-depth.mjs";
import * as maxParams from "./max-params.mjs";
import * as noBooleanFlags from "./no-boolean-flags.mjs";
import * as noCallbackPyramid from "./no-callback-pyramid.mjs";
import * as noDebugLog from "./no-debug-log.mjs";
import * as noFunctionClass from "./no-function-class.mjs";
import * as noMockDataInSource from "./no-mock-data-in-source.mjs";
import * as noNestedTernary from "./no-nested-ternary.mjs";
import * as noPlaceholderCopy from "./no-placeholder-copy.mjs";
import * as noPassThrough from "./no-pass-through.mjs";
import * as noPropForwardingWrapper from "./no-prop-forwarding-wrapper.mjs";
import * as noRestatingComment from "./no-restating-comment.mjs";
import * as noSingleImplementation from "./no-single-implementation.mjs";
import * as noThrowawayName from "./no-throwaway-name.mjs";

/** @type {{ id: string, pack: string, rule: unknown, bad: string[], good: string[], ext?: string }[]} */
export default [
  noAliasModule,
  maxFunctionStatements,
  maxNestingDepth,
  maxParams,
  noBooleanFlags,
  noCallbackPyramid,
  noDebugLog,
  noFunctionClass,
  noMockDataInSource,
  noNestedTernary,
  noPassThrough,
  noPlaceholderCopy,
  noPropForwardingWrapper,
  noRestatingComment,
  noSingleImplementation,
  noThrowawayName,
];
