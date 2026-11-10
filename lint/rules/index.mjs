// @ts-check
// Rules a selector cannot express. Add a rule here after writing lint/rules/<id>.mjs.
import * as noLintSuppression from "./no-lint-suppression.mjs";
import * as noSelfComparisonAssertion from "./no-self-comparison-assertion.mjs";
import * as requireAssertion from "./require-assertion.mjs";

export default [noLintSuppression, noSelfComparisonAssertion, requireAssertion];
