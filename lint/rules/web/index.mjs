// @ts-check
// Code rules for the web area: import each rule module here and list it.
import * as noCredentialedWildcardCors from "./no-credentialed-wildcard-cors.mjs";
import * as noDefaultSecret from "./no-default-secret.mjs";
import * as noInsecureSessionCookie from "./no-insecure-session-cookie.mjs";
import * as noInterpolatedSql from "./no-interpolated-sql.mjs";
import * as noFastPasswordHash from "./no-fast-password-hash.mjs";
import * as noInsecureRandom from "./no-insecure-random.mjs";
import * as noJwtDecodeWithoutVerify from "./no-jwt-decode-without-verify.mjs";
import * as noMassAssignment from "./no-mass-assignment.mjs";
import * as noOpenRedirect from "./no-open-redirect.mjs";
import * as noSecretInLog from "./no-secret-in-log.mjs";
import * as noServerEnvInClient from "./no-server-env-in-client.mjs";
import * as noTimingUnsafeSecretCompare from "./no-timing-unsafe-secret-compare.mjs";
import * as noShellInjection from "./no-shell-injection.mjs";
import * as noUnguardedServerAction from "./no-unguarded-server-action.mjs";
import * as noUnverifiedStripeWebhook from "./no-unverified-stripe-webhook.mjs";

/** @type {{ id: string, pack: string, rule: unknown, bad: string[], good: string[] }[]} */
export default [
  noCredentialedWildcardCors,
  noDefaultSecret,
  noFastPasswordHash,
  noInsecureRandom,
  noInsecureSessionCookie,
  noInterpolatedSql,
  noJwtDecodeWithoutVerify,
  noMassAssignment,
  noOpenRedirect,
  noSecretInLog,
  noServerEnvInClient,
  noShellInjection,
  noTimingUnsafeSecretCompare,
  noUnguardedServerAction,
  noUnverifiedStripeWebhook,
];
