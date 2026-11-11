// @ts-check
// Rules a selector cannot express. Add a rule here after writing lint/rules/<id>.mjs.
import * as noBooleanStateCluster from "./no-boolean-state-cluster.mjs";
import * as noChangeNarration from "./no-change-narration.mjs";
import * as noCommentedOutCode from "./no-commented-out-code.mjs";
import * as noConditionalAssertion from "./no-conditional-assertion.mjs";
import * as noElidedCode from "./no-elided-code.mjs";
import * as noEmptyCatch from "./no-empty-catch.mjs";
import * as noHotPathOverhead from "./no-hot-path-overhead.mjs";
import * as noLintSuppression from "./no-lint-suppression.mjs";
import * as noMockOnlyAssertions from "./no-mock-only-assertions.mjs";
import * as noModuleScopeLet from "./no-module-scope-let.mjs";
import * as noSelfComparisonAssertion from "./no-self-comparison-assertion.mjs";
import * as noSilentFallback from "./no-silent-fallback.mjs";
import * as noSwallowedTestFailure from "./no-swallowed-test-failure.mjs";
import * as requireAssertion from "./require-assertion.mjs";
import * as requireCommentTag from "./require-comment-tag.mjs";
import * as requireSafetyCommentOnCast from "./require-safety-comment-on-cast.mjs";
import asyncRules from "./async/index.mjs";
import frameworkRules from "./frameworks/index.mjs";
import namingRules from "./naming/index.mjs";
import reactRules from "./react/index.mjs";
import structureRules from "./structure/index.mjs";
import uiRules from "./ui/index.mjs";
import validationRules from "./validation/index.mjs";
import webRules from "./web/index.mjs";

export default [
  noBooleanStateCluster,
  noChangeNarration,
  noCommentedOutCode,
  noConditionalAssertion,
  noElidedCode,
  noEmptyCatch,
  noHotPathOverhead,
  noLintSuppression,
  noMockOnlyAssertions,
  noModuleScopeLet,
  noSelfComparisonAssertion,
  noSilentFallback,
  noSwallowedTestFailure,
  requireAssertion,
  requireCommentTag,
  requireSafetyCommentOnCast,
  ...asyncRules,
  ...frameworkRules,
  ...namingRules,
  ...reactRules,
  ...structureRules,
  ...uiRules,
  ...validationRules,
  ...webRules,
];
