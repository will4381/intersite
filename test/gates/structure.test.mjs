// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const lines = (/** @type {string[]} */ out) => out.map((line) => line.split(" | ")[0]);

test("an import that closes a circle between folders side by side is reported where it is added; a type import is not", async () => {
  const r = repo({
    "src/lib/format.ts": "export const format = (n: number) => n.toFixed(2);\n",
    "src/components/badge.ts": "import { format } from '../lib/format';\nexport const TONES = ['ok', 'bad'];\nexport type Tone = (typeof TONES)[number];\nexport const badge = (n: number) => format(n);\n",
  });
  r.write({ "src/lib/tone.ts": "import type { Tone } from '../components/badge';\nexport const loud = (t: Tone) => t.toUpperCase();\n" });
  const typed = await run(r.cwd, ["structure"]);
  assert.equal(typed.code, 0, typed.out.join("\n"));
  r.write({ "src/lib/tone.ts": "import { TONES } from '../components/badge';\nexport const loud = (i: number) => TONES[i].toUpperCase();\n" });
  const { code, out } = await run(r.cwd, ["structure"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/lib/tone.ts:2 lib and components in src use each other in a circle: lib uses TONES from components here, and 1 use goes the other way. Decide which one sits below the other and move what it takes from the one above into it (or into a module both use)"]);
  assert.match(out[0], /"target": "module-cycle src\/components src\/lib"/);
});

test("a folder's index and a file inside it that call each other are a tangle", async () => {
  const r = repo({
    "src/kernel/index.ts": "import { fire } from './timers';\nexport function spawn(n: number): number { return n > 0 ? fire(n - 1) : 0; }\n",
    "src/kernel/timers.ts": "export function fire(n: number): number { return n; }\n",
  });
  r.write({ "src/kernel/timers.ts": "import { spawn } from './index';\nexport function fire(n: number): number { return spawn(n); }\n" });
  const { code, out } = await run(r.cwd, ["structure"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/kernel/timers.ts:2 fire (src/kernel/timers.ts) and spawn (src/kernel/index.ts) know each other in a circle: here fire uses spawn, and spawn uses fire back. Break it: let the code that needs both call them, or pass in what one needs as an argument"]);
});

test("a field changed from outside its class is reported through a barrel, a typed property and an imported instance; reading it is not", async () => {
  const r = repo({
    "src/queue/run-queue.ts": "export class RunQueue {\n  items: string[] = [];\n  private head = 0;\n  next() { this.head++; return this.items[this.head]; }\n}\nexport const queue = new RunQueue();\n",
    "src/queue/index.ts": "export * from './run-queue';\n",
    "src/report.ts": "import { queue } from './queue';\nexport const size = () => queue.items.length;\n",
  });
  r.write({
    "src/sched.ts": "import { RunQueue, queue } from './queue';\nexport class Scheduler {\n  constructor(private q: RunQueue) {}\n  admit(job: string) { this.q.items.push(job); }\n}\nexport const reset = () => { queue.items = []; };\n",
  });
  const { code, out } = await run(r.cwd, ["structure"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/sched.ts:4 `this.q.items.push` changes RunQueue's `items` from outside RunQueue (2 places in 1 file). Give RunQueue a method that makes this change, and keep `items` to itself, so its rules live in one place"]);
});

test("a caller that works through most of a folder's functions on one type, step by step, makes the folder shallow", async () => {
  const ops = ["export type Cart = { items: string[]; total: number };"];
  for (const name of ["add", "remove", "clear", "price", "tax", "discount", "ship", "round", "total"]) ops.push(`export function ${name}(c: Cart) { c.total += c.items.length; return c; }`);
  const r = repo({ "src/cart/ops.ts": `${ops.join("\n")}\n`, "src/checkout.ts": "export const checkout = () => 0;\n" });
  r.write({ "src/checkout.ts": "import { add, remove, clear, price, tax, discount, ship, round, total, type Cart } from './cart/ops';\nexport function checkout(c: Cart) {\n  add(c); remove(c); clear(c); price(c); tax(c); discount(c); ship(c); round(c);\n  return total(c);\n}\n" });
  const { code, out } = await run(r.cwd, ["structure"]);
  assert.equal(code, 1);
  assert.deepEqual(lines(out), ["src/checkout.ts:3 checkout (src/checkout.ts) calls 9 of src/cart's functions on Cart (add, clear, discount and 6 more), and code outside src/cart calls 9 of its 9: the caller does src/cart's work step by step. Give src/cart a few functions that each do a whole job with Cart, and keep the steps inside"]);
});

test("--all reports every circle, and --write records them so only new ones fail", async () => {
  const r = repo({
    "a/x.ts": "import { y } from '../b/y';\nexport const x = () => y();\nexport const z = 1;\n",
    "b/y.ts": "import { z } from '../a/x';\nexport const y = () => z;\n",
  });
  const all = await run(r.cwd, ["structure", "--all"]);
  assert.equal(all.code, 1);
  assert.deepEqual(lines(all.out), ["a/x.ts:2 a and b use each other in a circle: a uses y from b here, and 1 use goes the other way. Decide which one sits below the other and move what it takes from the one above into it (or into a module both use)"]);
  await run(r.cwd, ["structure", "--all", "--write"]);
  const after = await run(r.cwd, ["structure", "--all"]);
  assert.equal(after.code, 0, after.out.join("\n"));
});
