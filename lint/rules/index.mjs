// @ts-check
// Rules a selector cannot express. Add a rule here after writing lint/rules/<id>.mjs.
import * as noAbsenceOnlyTest from "./no-absence-only-test.mjs";
import * as noBooleanStateCluster from "./no-boolean-state-cluster.mjs";
import * as noChangeNarration from "./no-change-narration.mjs";
import * as noCommentedOutCode from "./no-commented-out-code.mjs";
import * as noConditionalAssertion from "./no-conditional-assertion.mjs";
import * as noDefensiveTry from "./no-defensive-try.mjs";
import * as noDerivedExpectation from "./no-derived-expectation.mjs";
import * as noElidedCode from "./no-elided-code.mjs";
import * as noEmptyCatch from "./no-empty-catch.mjs";
import * as noGuardSuppression from "./no-guard-suppression.mjs";
import * as noHotPathOverhead from "./no-hot-path-overhead.mjs";
import * as noLintSuppression from "./no-lint-suppression.mjs";
import * as noMockOnlyAssertions from "./no-mock-only-assertions.mjs";
import * as noReduceAccumulatorCopy from "./no-reduce-accumulator-copy.mjs";
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
import reactNativeRules from "./react-native/index.mjs";
import structureRules from "./structure/index.mjs";
import uiRules from "./ui/index.mjs";
import validationRules from "./validation/index.mjs";
import webRules from "./web/index.mjs";

export default [
  noAbsenceOnlyTest,
  noBooleanStateCluster,
  noChangeNarration,
  noCommentedOutCode,
  noConditionalAssertion,
  noDefensiveTry,
  noDerivedExpectation,
  noElidedCode,
  noEmptyCatch,
  noGuardSuppression,
  noHotPathOverhead,
  noLintSuppression,
  noMockOnlyAssertions,
  noReduceAccumulatorCopy,
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
  ...reactNativeRules,
  ...structureRules,
  ...uiRules,
  ...validationRules,
  ...webRules,
];
