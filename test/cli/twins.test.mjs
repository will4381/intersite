// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import twins from "../../cli/twins.mjs";
import { repo } from "../gates/repo.mjs";

/** @param {string} cwd @param {string[]} args */
async function run(cwd, args) {
  /** @type {string[]} */ const out = [];
  const { log } = console;
  console.log = (/** @type {string} */ line) => out.push(line);
  try {
    return { code: await twins(args, { cwd }), out };
  } finally {
    console.log = log;
  }
}

const fetchUser = "export async function fetchUserById(id) {\n  const row = await prisma.user.findUnique({ where: { id } });\n  if (!row) throw new NotFoundError('user not found');\n  return { id: row.id, email: row.email, name: row.displayName };\n}\n";
const invoice = "export function formatInvoiceTotal(lines, currency) {\n  const cents = lines.reduce((sum, line) => sum + line.amountCents * line.quantity, 0);\n  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);\n}\n";
// Unrelated helpers, so word weights behave as they do across a real codebase: a word in every function counts for little.
const others = {
  "src/text/slug.ts": "export function slugify(title) {\n  const lower = title.toLowerCase().normalize('NFKD');\n  const dashed = lower.replace(/[^a-z0-9]+/g, '-');\n  return dashed.replace(/^-+|-+$/g, '');\n}\n",
  "src/timing/debounce.ts": "export function debounce(callback, waitMs) {\n  let timer;\n  return (...args) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => callback(...args), waitMs);\n  };\n}\n",
  "src/mail/welcome.ts": "export async function sendWelcomeEmail(mailer, address, firstName) {\n  const subject = `Welcome, ${firstName}`;\n  const body = renderTemplate('welcome', { firstName });\n  await mailer.send({ to: address, subject, body });\n}\n",
  "src/csv/row.ts": "export function parseCsvRow(line, separator) {\n  const cells = line.split(separator);\n  return cells.map((cell) => cell.trim().replace(/^\"|\"$/g, ''));\n}\n",
};
const loadUser = "export const loadUser = async (userId) => {\n  const user = await prisma.user.findFirst({ where: { id: userId } });\n  if (user === null) {\n    throw new NotFoundError(`no user ${userId}`);\n  }\n  return { id: user.id, email: user.email, name: user.displayName };\n};\n";

test("a function added that does the job of an existing one, in different code, is named with what they share", async () => {
  const r = repo({ "src/users/read.ts": fetchUser, "src/billing/format.ts": invoice, ...others });
  r.write({ "src/profile/load.ts": loadUser });
  const { out } = await run(r.cwd, []);
  assert.equal(out.length, 1);
  assert.match(out[0], /^src\/profile\/load\.ts:1 loadUser looks like it does the job of src\/users\/read\.ts:1 fetchUserById \(\d+% alike in what they use: [a-z, ]+\): read it, and call it or merge the two if so$/);
});

test("a line finds the functions most like the one around it; unrelated code finds none", async () => {
  const r = repo({ "src/users/read.ts": fetchUser, "src/billing/format.ts": invoice, "src/profile/load.ts": loadUser, ...others });
  const near = await run(r.cwd, ["src/profile/load.ts:3"]);
  assert.match(near.out[0], /^src\/users\/read\.ts:1 fetchUserById: \d+% alike \(/);
  assert.equal(near.out.length, 1);
  const none = await run(r.cwd, []);
  assert.match(none.out[0], /^ok twins: /);
});
