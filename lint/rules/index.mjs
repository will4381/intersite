// @ts-check
// Rules a selector cannot express. Add a rule here after writing lint/rules/<id>.mjs.
import * as noBooleanStateCluster from "./no-boolean-state-cluster.mjs";
import * as noChangeNarration from "./no-change-narration.mjs";
import * as noCommentedOutCode from "./no-commented-out-code.mjs";
import * as noConditionalAssertion from "./no-conditional-assertion.mjs";
import * as noElidedCode from "./no-elided-code.mjs";
import * as noLintSuppression from "./no-lint-suppression.mjs";
import * as noMockOnlyAssertions from "./no-mock-only-assertions.mjs";
import * as noModuleScopeLet from "./no-module-scope-let.mjs";
import * as noSelfComparisonAssertion from "./no-self-comparison-assertion.mjs";
import * as noSilentFallback from "./no-silent-fallback.mjs";
import * as requireAssertion from "./require-assertion.mjs";

export default [
  noBooleanStateCluster,
  noChangeNarration,
  noCommentedOutCode,
  noConditionalAssertion,
  noElidedCode,
  noLintSuppression,
  noMockOnlyAssertions,
  noModuleScopeLet,
  noSelfComparisonAssertion,
  noSilentFallback,
  requireAssertion,
];
