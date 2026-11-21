// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { renames } from "../../gates/renames.mjs";
import { TEST_PATHS } from "../../shared/config.mjs";
import { repo } from "./repo.mjs";

/** @param {string} cwd */
const check = async (cwd) => (await renames({ cwd, base: "base", testPaths: TEST_PATHS, testCmd: "", setup: "", duplicateLines: 6, mutants: 0, timeout: 0, entryPaths: [], artifacts: [] })).findings.map((f) => f.message);

test("a rename finished in code but left in strings and docs is reported; a partial rename is not", async () => {
  const r = repo({
    "src/orders.ts": "export function fetchOrders(userId) { return db.orders(userId); }\n",
    "src/page.ts": "import { fetchOrders } from './orders';\nexport const load = (id) => fetchOrders(id).catch(() => { throw new Error('fetchOrders failed'); });\n",
    "docs/api.md": "# API\n\nCall `fetchOrders(userId)` to list a user's orders.\n",
    "src/users.ts": "export function loadProfile(id) { return db.profile(id); }\nexport const again = () => loadProfile(1);\n",
  });
  r.write({
    "src/orders.ts": "export function listOrders(userId) { return db.orders(userId); }\n",
    "src/page.ts": "import { listOrders } from './orders';\nexport const load = (id) => listOrders(id).catch(() => { throw new Error('fetchOrders failed'); });\n",
    "src/users.ts": "export function readProfile(id) { return db.profile(id); }\nexport const again = () => loadProfile(1);\n",
  });
  assert.deepEqual(await check(r.cwd), [
    "src/orders.ts:1 renames fetchOrders to listOrders in code, but fetchOrders is still written in docs/api.md:3, src/page.ts:2: strings, comments and docs that nothing checks; rename those too",
  ]);
});
