// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { styleDrift } from "../../gates/style-drift.mjs";
import { TEST_PATHS } from "../../shared/config.mjs";
import { repo } from "./repo.mjs";

/** @param {string} cwd */
const check = async (cwd) => (await styleDrift({ cwd, base: "base", testPaths: TEST_PATHS, testCmd: "", setup: "", duplicateLines: 6, mutants: 0, timeout: 0, entryPaths: [], artifacts: [] })).findings.map((f) => f.message);

const tokens = ":root {\n  --color-ink: #333333;\n  --gray-700: #374151;\n}\n";
const uses = ".title { color: var(--color-ink); }\n.body { color: var(--color-ink); }\n.note { color: var(--color-ink); border-color: var(--gray-700); }\n";
// A closed type scale: 45 font sizes, all one of five steps.
const scale = ["12px", "14px", "16px", "20px", "24px"].flatMap((size, i) => Array.from({ length: 9 }, (_, j) => `.t${i}-${j} { font-size: ${size}; }`)).join("\n");
const base = { "src/styles/tokens.css": tokens, "src/styles/app.css": uses, "src/styles/type.css": scale };

test("a near-duplicate colour is reported with the token and its use count, and a token's exact value with its name", async () => {
  const r = repo(base);
  r.write({ "src/ui/card.css": ".card { color: #343434; }\n.card strong { color: #333333; }\n" });
  assert.deepEqual(await check(r.cwd), [
    "src/ui/card.css:1 colour #343434 is nearly #333333 (--color-ink, used 3 times): use the token",
    "src/ui/card.css:2 colour #333333 is the value of --color-ink (used 3 times): use the token",
  ]);
});

test("a colour far from everything is a new colour, not drift", async () => {
  const r = repo(base);
  r.write({ "src/ui/badge.css": ".badge { background: #ff00aa; }\n" });
  assert.deepEqual(await check(r.cwd), []);
});

test("a font size a pixel off the scale, and one off a closed scale, are reported", async () => {
  const r = repo(base);
  r.write({ "src/ui/label.css": ".label { font-size: 13px; }\n.hero { font-size: 40px; }\n" });
  assert.deepEqual(await check(r.cwd), [
    "src/ui/label.css:1 font size 13px is nearly 12px (used 9 times) or 14px (used 9 times): use one of those",
    "src/ui/label.css:2 font size 40px is off this project's scale (12px, 14px, 16px, 20px, 24px: 100% of 45 uses): use 24px",
  ]);
});

test("a new token nearly equal to one in its family is reported", async () => {
  const r = repo(base);
  r.write({ "src/styles/tokens.css": `${tokens}:root { --gray-750: #384152; }\n` });
  assert.deepEqual(await check(r.cwd), ["src/styles/tokens.css:5 token --gray-750 (#384152) is nearly --gray-700 (#374151): use --gray-700, or make the two clearly different"]);
});

test("values in tests, SVG assets and data files are ignored", async () => {
  const r = repo(base);
  r.write({
    "src/ui/card.test.tsx": "export const style = { color: '#343434' };\n",
    "src/assets/icon.svg": '<svg><path fill="#343434"/></svg>\n',
    "src/data/colours.json": '{ "ink": "#343434" }\n',
  });
  assert.deepEqual(await check(r.cwd), []);
});

test("a colour function built from variables is not read as a literal", async () => {
  const { parseColour } = await import("../../gates/style-values.mjs");
  assert.equal(parseColour("hsl(var(--ring))"), undefined);
  assert.equal(parseColour("rgb(var(--ink) / 0.5)"), undefined);
  assert.deepEqual(parseColour("rgb(51, 51, 51)")?.key, "#333333");
});
