// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { gates, runGate } from "../../cli/gate.mjs";
import { naming } from "../../gates/naming.mjs";
import { loadConfig, TEST_PATHS } from "../../shared/config.mjs";
import { repo } from "./repo.mjs";

/** @param {string} cwd */
const check = async (cwd) => (await naming({ cwd, base: "base", testPaths: TEST_PATHS, testCmd: "", setup: "", duplicateLines: 6, mutants: 0, timeout: 0, entryPaths: [], artifacts: [] })).findings;

/** Components that each default-export a function named after their file. @param {string} dir @param {string[]} names */
const components = (dir, names) => Object.fromEntries(names.map((n) => [`${dir}/${n}.tsx`, `export default function ${n}() { return null; }\n`]));
const pascal = components("src/components", ["UserAvatar", "ProfileCard", "SettingsPanel", "NavBar", "FooterLinks"]);

test("a snake_case file added to a PascalCase folder is reported with the expected name and the sibling count, untracked", async () => {
  const r = repo(pascal);
  r.write({ "src/components/user_card.tsx": "export default function UserCard() { return null; }\n" });
  assert.deepEqual(await check(r.cwd), [
    { target: "src/components/user_card.tsx", message: "src/components/user_card.tsx: this folder names files in PascalCase (5 of 5): rename to UserCard.tsx" },
  ]);
});

test("the same file in a folder with no clear convention, or with too few siblings, is not reported", async () => {
  const mixed = { ...components("src/mixed", ["UserAvatar", "ProfileCard", "NavBar"]), "src/mixed/date-utils.ts": "", "src/mixed/form-state.ts": "", "src/mixed/api-client.ts": "" };
  const r = repo({ ...mixed, ...components("src/few", ["UserAvatar", "ProfileCard"]) });
  r.write({ "src/mixed/user_card.tsx": "export default function UserCard() { return null; }\n", "src/few/user_card.tsx": "export default function UserCard() { return null; }\n" });
  assert.deepEqual(await check(r.cwd), []);
});

test("framework-reserved names are never reported", async () => {
  const r = repo(pascal);
  r.write({ "src/components/index.tsx": "", "src/components/[id].tsx": "", "src/components/$param.tsx": "", "src/components/__root.tsx": "", "src/components/page.tsx": "" });
  assert.deepEqual(await check(r.cwd), []);
});

test("a default export named unlike its file is reported where the folder keeps them matched", async () => {
  const r = repo(pascal);
  r.write({ "src/components/Banner.tsx": "export default function HeroSection() { return null; }\n" });
  const [finding, ...rest] = await check(r.cwd);
  assert.deepEqual(rest, []);
  assert.equal(finding.message, "src/components/Banner.tsx: its main export is HeroSection, and files in this folder are named after theirs (5 of 5): rename the file to HeroSection.tsx, or the export to match the file");
});

test("a test named unlike the folder's tests, and an added folder named unlike its siblings, are reported", async () => {
  const tests = Object.fromEntries(["cart", "order", "invoice", "refund", "coupon"].map((n) => [`src/billing/${n}.test.ts`, ""]));
  const folders = Object.fromEntries(["user-profile", "order-history", "billing-settings", "team-members", "api-keys"].map((d) => [`src/features/${d}/index.ts`, ""]));
  const r = repo({ ...tests, ...folders });
  r.write({ "src/billing/tax.spec.ts": "", "src/features/notification_prefs/index.ts": "" });
  assert.deepEqual((await check(r.cwd)).map((f) => f.message).sort(), [
    "src/billing/tax.spec.ts: tests in this folder are named *.test.* (5 of 5): rename to tax.test.ts",
    "src/features/notification_prefs/: folders beside it are named in kebab-case (5 of 5): rename to notification-prefs",
  ]);
});

test("an acknowledged target is not reported", async () => {
  const r = repo(pascal, { acknowledged: [{ gate: "naming", target: "src/components/user_card.tsx", why: "matches the CMS slug" }] });
  r.write({ "src/components/user_card.tsx": "export default function UserCard() { return null; }\n" });
  // ponytail: registers the gate for this test until cli/gate.mjs lists it; harmless once it does
  Object.assign(gates, { naming });
  const { findings } = await runGate("naming", { cwd: r.cwd, config: loadConfig(r.cwd) });
  assert.deepEqual(findings, []);
});
