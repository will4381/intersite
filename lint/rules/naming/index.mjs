// @ts-check
// Code rules for the naming area: import each rule module here and list it.
import * as noAbbreviationSoup from "./no-abbreviation-soup.mjs";
import * as noLowercaseComponent from "./no-lowercase-component.mjs";
import * as noLowercaseTypeName from "./no-lowercase-type-name.mjs";
import * as noMisnamedHook from "./no-misnamed-hook.mjs";
import * as noMixedAcronymCase from "./no-mixed-acronym-case.mjs";
import * as noMixedCaseStyle from "./no-mixed-case-style.mjs";
import * as noOverlongName from "./no-overlong-name.mjs";
import * as noReassignedConstant from "./no-reassigned-constant.mjs";
import * as noSingleLetterName from "./no-single-letter-name.mjs";
import * as noTypeInName from "./no-type-in-name.mjs";

/** @type {{ id: string, pack: string, rule: unknown, bad: string[], good: string[], ext?: string }[]} */
export default [
  noAbbreviationSoup,
  noLowercaseComponent,
  noLowercaseTypeName,
  noMisnamedHook,
  noMixedAcronymCase,
  noMixedCaseStyle,
  noOverlongName,
  noReassignedConstant,
  noSingleLetterName,
  noTypeInName,
];
