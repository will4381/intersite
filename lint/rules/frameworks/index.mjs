// @ts-check
// Code rules for framework-specific mistakes: import each rule module here and list it.
import * as noCheckThenInsert from "./no-check-then-insert.mjs";
import * as noClientUserId from "./no-client-user-id.mjs";
import * as noFloatMoney from "./no-float-money.mjs";
import * as noFloatingWorkerPromise from "./no-floating-worker-promise.mjs";
import * as noIdentityServerFnValidator from "./no-identity-server-fn-validator.mjs";
import * as noIgnoredSupabaseError from "./no-ignored-supabase-error.mjs";
import * as noOuterClientInTransaction from "./no-outer-client-in-transaction.mjs";
import * as noPrismaClientPerRequest from "./no-prisma-client-per-request.mjs";
import * as noQueryInLoop from "./no-query-in-loop.mjs";
import * as noResponseAfterSend from "./no-response-after-send.mjs";
import * as noSupabaseGetSessionOnServer from "./no-supabase-get-session-on-server.mjs";
import * as noUnguardedStatusWrite from "./no-unguarded-status-write.mjs";
import * as noUnhandledAsyncExpressHandler from "./no-unhandled-async-express-handler.mjs";
import * as noUnsafeStripeAmount from "./no-unsafe-stripe-amount.mjs";
import * as noUnscopedWrite from "./no-unscoped-write.mjs";
import * as requireStripeIdempotencyKey from "./require-stripe-idempotency-key.mjs";
import * as queryFnNonNullWithoutEnabled from "./query-fn-non-null-without-enabled.mjs";
import * as queryKeyMissingDep from "./query-key-missing-dep.mjs";

/** @type {{ id: string, pack: string, rule: unknown, bad: string[], good: string[], ext?: string }[]} */
export default [
  noCheckThenInsert,
  noClientUserId,
  noFloatMoney,
  noFloatingWorkerPromise,
  noIdentityServerFnValidator,
  noIgnoredSupabaseError,
  noOuterClientInTransaction,
  noPrismaClientPerRequest,
  noQueryInLoop,
  noResponseAfterSend,
  noSupabaseGetSessionOnServer,
  noUnguardedStatusWrite,
  noUnhandledAsyncExpressHandler,
  noUnsafeStripeAmount,
  noUnscopedWrite,
  queryFnNonNullWithoutEnabled,
  queryKeyMissingDep,
  requireStripeIdempotencyKey,
];
