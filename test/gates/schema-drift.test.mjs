// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { schemaDrift } from "../../gates/schema-drift.mjs";
import { TEST_PATHS } from "../../shared/config.mjs";
import { repo } from "./repo.mjs";

/** @param {string} cwd */
const check = async (cwd) => (await schemaDrift({ cwd, base: "base", testPaths: TEST_PATHS, testCmd: "", setup: "", duplicateLines: 6, mutants: 0, timeout: 0, entryPaths: [], artifacts: [], protected: [] })).findings.map((f) => f.message);

test("a type that restates a schema's keys by hand is reported with the derivation; a derived or different type is not", async () => {
  const r = repo({
    "src/schemas.ts": "import { z } from 'zod';\nexport const UserSchema = z.object({ id: z.string(), email: z.string(), name: z.string(), plan: z.enum(['free', 'pro']) });\n",
    "src/db.ts": "export const orders = pgTable('orders', { id: uuid('id'), userId: uuid('user_id'), total: integer('total'), status: text('status') });\n",
  });
  r.write({
    "src/user.ts": "export interface User { id: string; email: string; name: string; plan: 'free' | 'pro' }\nexport type Derived = z.infer<typeof UserSchema>;\nexport type Card = { id: string; email: string; name: string; avatar: string };\n",
    "src/order.ts": "export type Order = { id: string; userId: string; total: number; status: string };\n",
  });
  assert.deepEqual(await check(r.cwd), [
    "src/order.ts:1 Order restates by hand the 4 keys of orders at src/db.ts:1, so the two drift the first time one changes and nothing checks one against the other: derive it, type Order = typeof orders.$inferSelect",
    "src/user.ts:1 User restates by hand the 4 keys of UserSchema at src/schemas.ts:2, so the two drift the first time one changes and nothing checks one against the other: derive it, type User = z.infer<typeof UserSchema>",
  ]);
});
