// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isGenerated, isTestFile } from "../shared.mjs";

// A stanza is two or more statements in a row with at least this many syntax nodes: smaller repeats are idioms.
const MIN_NODES = 20;
// The repeat starts within this many lines of the original: further apart, the duplicates gate's job.
const NEAR = 32;
/** Node keys that are positions or types, not shape: two copies with different types are still one stanza. */
const NOT_SHAPE = new Set(["parent", "loc", "range", "start", "end", "typeAnnotation", "typeArguments", "typeParameters", "returnType"]);

/**
 * A statement's shape: its node types, operators and flags with every name and value left out, so
 * `const a = get("a")` and `const b = get("b")` match; and its size in nodes.
 * @param {any} node @returns {{ shape: string, size: number }}
 */
function shapeOf(node) {
  let size = 0;
  /** @param {any} n @returns {string} */
  const visit = (n) => {
    size++;
    let out = n.type;
    if (typeof n.operator === "string") out += n.operator;
    for (const key in n) {
      if (NOT_SHAPE.has(key)) continue;
      const v = n[key];
      if (Array.isArray(v)) out += `[${v.map((c) => (c && typeof c.type === "string" ? visit(c) : "_")).join(",")}]`;
      else if (v && typeof v.type === "string") out += `(${visit(v)})`;
      // Strings are names, values and the type itself; a set flag (`computed`, `async`, `optional`) is shape.
      else if (v === true) out += key[0];
    }
    return out;
  };
  return { shape: visit(node), size };
}

/**
 * Whether the two statements at `i` appear again after the copy at `j`, within reach.
 * @param {{ shape: string }[]} shapes @param {any[]} body @param {number} i @param {number} j
 */
function thirdCopy(shapes, body, i, j) {
  for (let m = j + 2; m + 1 < body.length && body[m].loc.start.line - body[j].loc.start.line <= NEAR; m++) {
    if (shapes[m].shape === shapes[i].shape && shapes[m + 1].shape === shapes[i + 1].shape) return true;
  }
  return false;
}

export const id = "no-repeated-stanza";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      repeated: `Lines {{from}}-{{to}} repeat lines {{at}}-{{atEnd}} with different names and values, so a fix to one copy will miss the other. Loop over the values, or move the steps into a function that takes what differs as parameters.`,
    },
  },
  createOnce(context) {
    /** @param {any[]} body */
    function check(body) {
      if (body.length < 4) return;
      const shapes = body.map(shapeOf);
      for (let j = 2; j < body.length; j++) {
        for (let i = 0; i + 1 < j; i++) {
          if (body[j].loc.start.line - body[i].loc.start.line > NEAR) continue;
          // The longest run from i that j repeats, stopping before the two overlap.
          let k = 0;
          while (i + k < j && j + k < body.length && shapes[i + k].shape === shapes[j + k].shape) k++;
          if (k < 2) continue;
          // Two statements twice is common enough to be chance; three statements, or a third copy, is a pattern.
          if (k === 2 && !thirdCopy(shapes, body, i, j)) continue;
          const run = shapes.slice(j, j + k);
          // Statements of one kind (declarations in a row, a ladder of ifs) are a list, which reads fine; a stanza does
          // several kinds of thing, such as read a value, then check it.
          if (new Set(body.slice(j, j + k).map((n) => n.type)).size < 2) continue;
          if (run.reduce((sum, s) => sum + s.size, 0) < MIN_NODES) continue;
          const from = body[j].loc.start.line;
          const to = body[j + k - 1].loc.end.line;
          context.report({ node: body[j], messageId: "repeated", data: { from: String(from), to: String(to), at: String(body[i].loc.start.line), atEnd: String(body[i + k - 1].loc.end.line) } });
          j += k - 1;
          break;
        }
      }
    }
    return {
      // Tests repeat arrange-act-assert on purpose; generated code is the generator's to shape.
      before: () => !isTestFile(context) && !isGenerated(context),
      BlockStatement: (/** @type {any} */ node) => check(node.body),
      SwitchCase: (/** @type {any} */ node) => check(node.consequent),
    };
  },
});

export const bad = [
  "export function parse(form) {\n  const name = form.get('name');\n  if (typeof name !== 'string' || !name.trim()) throw new Error('name is required');\n  const email = form.get('email');\n  if (typeof email !== 'string' || !email.trim()) throw new Error('email is required');\n  const phone = form.get('phone');\n  if (typeof phone !== 'string' || !phone.trim()) throw new Error('phone is required');\n  return { name, email, phone };\n}",
  "export async function sync(db, api) {\n  const users = await api.list('users', { since: db.cursor('users') });\n  for (const user of users) await db.upsert('users', user);\n  await db.mark('users', users.length);\n  const teams = await api.list('teams', { since: db.cursor('teams') });\n  for (const team of teams) await db.upsert('teams', team);\n  await db.mark('teams', teams.length);\n}",
];

export const good = [
  "export function parse(form) {\n  const name = form.get('name');\n  const email = form.get('email');\n  const phone = form.get('phone');\n  const city = form.get('city');\n  return { name, email, phone, city };\n}",
  "export function Form() {\n  const [name, setName] = useState<string | null>(null);\n  const [open, setOpen] = useState(false);\n  const [email, setEmail] = useState<string | null>(null);\n  const [busy, setBusy] = useState(false);\n  return [name, setName, open, setOpen, email, setEmail, busy, setBusy];\n}",
  "export function ago(minutes) {\n  if (minutes < 60) return `${minutes}m ago`;\n  const hours = Math.round(minutes / 60);\n  if (hours < 48) return `${hours}h ago`;\n  const days = Math.round(hours / 24);\n  return `${days}d ago`;\n}",
  "export function parse(form) {\n  const name = read(form, 'name');\n  const email = read(form, 'email');\n  return { name, email };\n}",
  "export async function sync(db, api) {\n  const users = await api.list('users', { since: db.cursor('users') });\n  for (const user of users) await db.upsert('users', user);\n  await notify(users.length);\n  const teams = await api.list('teams');\n  if (!teams.length) return;\n  await db.replace('teams', teams);\n}",
];
