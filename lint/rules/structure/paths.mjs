// @ts-check
import { matchesGlob, relative } from "node:path";

import { TEST_PATHS } from "../../../shared/config.mjs";

/** Test helpers, fixtures, stories, mocks and seed scripts: places where sample data and odd shapes are the point. */
const notShipped = /(?:^|\/)(?:[\w-]*-test(?:s|ing)?|test|tests|testing|__tests__|__mocks__|mocks?|__fixtures__|fixtures?|stories|storybook|seeds?|e2e|qa)\/|(?:^|[/.-])(?:stories|story|fixtures?|mocks?|seeds?)\.[cm]?[jt]sx?$/;

/** Whether the file being linted is a test, fixture, story, mock or seed. @param {any} context */
export function isTestFile(context) {
  const file = relative(context.cwd, context.filename);
  return TEST_PATHS.some((glob) => matchesGlob(file, glob)) || notShipped.test(file);
}

/** Function nodes, as `type` values. */
export const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
