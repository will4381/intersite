// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { builtinRules, packageRules } from "../../lint/plugin.mjs";
import { fixture, runLint } from "./fixture.mjs";

test("every package rule reports its bad examples and none of its good ones", async () => {
  /** @type {Record<string, string>} */
  const files = { "intersite.json": JSON.stringify({ project: "rules", lint: { packs: [...new Set([...packageRules, ...builtinRules].map((r) => r.pack))] } }) };
  // Examples are TypeScript files unless the rule says otherwise (`ext: tsx` for JSX; .tsx cannot hold `<any>x` casts).
  /** @param {{ pack: string, ext?: string }} r */
  const ext = (r) => r.ext ?? (r.pack === "actions" ? "tsx" : "ts");
  for (const r of packageRules) {
    assert.ok(r.bad?.length, `${r.id} has no bad example`);
    assert.ok(r.good?.length, `${r.id} has no good example`);
    r.bad.forEach((code, i) => (files[`${r.id}/bad-${i}.${ext(r)}`] = code));
    r.good.forEach((code, i) => (files[`${r.id}/good-${i}.${ext(r)}`] = code));
  }
  const { out } = await runLint(fixture(files));

  /** @type {Set<string>} "file rule" for every finding */
  const reported = new Set(out.split("\n").map((line) => line.replace(/:\d+:\d+ (\S+) .*/, " $1")));
  const problems = [];
  for (const r of packageRules) {
    r.bad.forEach((code, i) => reported.has(`${r.id}/bad-${i}.${ext(r)} intersite/${r.id}`) || problems.push(`${r.id} missed bad: ${code}`));
    r.good.forEach((code, i) => reported.has(`${r.id}/good-${i}.${ext(r)} intersite/${r.id}`) && problems.push(`${r.id} flagged good: ${code}`));
  }
  assert.deepEqual(problems, [], out);
});
