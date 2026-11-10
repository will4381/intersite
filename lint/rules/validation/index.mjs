// @ts-check
// Code rules for type escapes (pack `types`) and missing validation at trust boundaries (pack `validation`).
import * as noAsNever from "./no-as-never.mjs";
import * as noCastExternalData from "./no-cast-external-data.mjs";
import * as noObjectLiteralCast from "./no-object-literal-cast.mjs";
import * as noDiscardedParse from "./no-discarded-parse.mjs";
import * as noEnvBypass from "./no-env-bypass.mjs";
import * as noNonNullOnInput from "./no-non-null-on-input.mjs";
import * as noUncheckedNumberInput from "./no-unchecked-number-input.mjs";
import * as noUncheckedTypePredicate from "./no-unchecked-type-predicate.mjs";
import * as noUnguardedStorageParse from "./no-unguarded-storage-parse.mjs";
import * as requirePaginationCap from "./require-pagination-cap.mjs";
import * as requireRequestValidation from "./require-request-validation.mjs";

/** @type {{ id: string, pack: string, rule: unknown, bad: string[], good: string[] }[]} */
export default [
  noAsNever,
  noCastExternalData,
  noDiscardedParse,
  noEnvBypass,
  noNonNullOnInput,
  noObjectLiteralCast,
  noUncheckedNumberInput,
  noUncheckedTypePredicate,
  noUnguardedStorageParse,
  requirePaginationCap,
  requireRequestValidation,
];
