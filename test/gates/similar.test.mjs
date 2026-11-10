// @ts-check
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { repo, run } from "./repo.mjs";

const profileCard = `import { useState } from "react";
import { Avatar } from "./avatar";
import { formatDate } from "../lib/date";

export function ProfileCard({ user, onSelect, compact }) {
  const [open, setOpen] = useState(false);
  const joined = formatDate(user.createdAt);
  if (!user) return null;
  return (
    <div className="card" onClick={() => onSelect(user.id)}>
      <Avatar src={user.avatarUrl} size={compact ? 32 : 48} />
      <div className="card-body">
        <h3>{user.name}</h3>
        <p>Joined {joined}</p>
        {open && <p>{user.bio}</p>}
        <button onClick={() => setOpen(!open)}>More</button>
      </div>
    </div>
  );
}
`;
// Every local name changed, props destructured in another order, reformatted, one label reworded.
const userCard = `import { useState } from "react";
import { formatDate } from "../lib/date";
import { Avatar } from "./avatar";

export const UserCard = ({ dense, member, onPick }) => {
  const [expanded, setExpanded] = useState(false);
  const since = formatDate(member.createdAt);
  if (!member) return null;
  return (
    <div className="card" onClick={() => onPick(member.id)}>
      <Avatar src={member.avatarUrl} size={dense ? 32 : 48} />
      <div className="card-body">
        <h3>{member.name}</h3>
        <p>Member since {since}</p>
        {expanded && <p>{member.bio}</p>}
        <button onClick={() => setExpanded(!expanded)}>Show more</button>
      </div>
    </div>
  );
};
`;
const signupForm = `import { useState } from "react";
import { submitSignup } from "../api/signup";

export function SignupForm({ plan }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState(null);
  async function onSubmit(event) {
    event.preventDefault();
    const result = await submitSignup({ email, plan });
    if (!result.ok) setError(result.message);
  }
  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      {error ? <span role="alert">{error}</span> : null}
      <button type="submit">Sign up for {plan}</button>
    </form>
  );
}
`;
const groupBy = `export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null || key === undefined) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
`;
const bucketRows = `export const bucketRows = (rows, pick) => {
  const buckets = new Map();
  for (const row of rows) {
    const id = pick(row);
    if (id === null || id === undefined) { continue; }
    const bucket = buckets.get(id);
    if (bucket) { bucket.push(row); } else { buckets.set(id, [row]); }
  }
  return buckets;
};
`;
const invoice = `export interface Invoice {
  id: string;
  customerId: string;
  amountCents: number;
  currency: string;
  issuedAt: Date;
  paidAt: Date | null;
}
`;
const bill = `export type Bill = {
  customerId: string
  id: string
  currency: string
  amountCents: number
  paidAt: Date | null
  issuedAt: Date
}
`;
const button = (name, classes) => `import { forwardRef } from "react";

export const ${name} = forwardRef(function ${name}({ children, disabled, onClick }, ref) {
  return (
    <button ref={ref} type="button" disabled={disabled} onClick={onClick} className="${classes}">
      <span className="inline-flex items-center gap-2">{children}</span>
    </button>
  );
});
`;
const page = (title) => `import { Shell } from "../../components/shell";
import { loadAccount } from "../../lib/account";

export default async function Page({ params }) {
  const account = await loadAccount(params.id);
  if (!account) return <Shell title="${title}">Not found</Shell>;
  return (
    <Shell title="${title}">
      <h1>{account.name}</h1>
      <p>{account.plan}</p>
    </Shell>
  );
}
`;

const accept = (target) => ` | to accept: add { "gate": "similar", "target": "${target}", "why": "…" } to gates.acknowledged in intersite.yml`;

test("a component copied with every name changed and props reordered is reported with both locations", async () => {
  const r = repo({ "src/components/ProfileCard.jsx": profileCard, "src/components/SignupForm.jsx": signupForm });
  r.write({ "src/components/UserCard.jsx": userCard });
  const { code, out } = await run(r.cwd, ["similar"]);
  assert.equal(code, 1);
  assert.equal(out.length, 1);
  assert.match(out[0], /^src\/components\/UserCard\.jsx:5 UserCard is \d+% the same as src\/components\/ProfileCard\.jsx:5 ProfileCard and differs only in 2 strings: make them one component with a variant prop \| to accept: add \{ "gate": "similar", "target": "src\/components\/UserCard\.jsx:UserCard"/);
});

test("two buttons that differ only in classes are told to become one component with a variant", async () => {
  const r = repo({ "src/PrimaryButton.jsx": button("PrimaryButton", "rounded-md bg-blue-600 px-4 py-2 text-white") });
  r.write({ "src/DangerButton.jsx": button("DangerButton", "rounded-md bg-red-600 px-4 py-2 text-white") });
  const { out } = await run(r.cwd, ["similar"]);
  assert.deepEqual(out, [
    `src/DangerButton.jsx:3 DangerButton is 100% the same as src/PrimaryButton.jsx:3 PrimaryButton and differs only in class names: make them one component with a variant prop${accept("src/DangerButton.jsx:DangerButton")}`,
  ]);
});

test("a renamed helper and a type with the same members are reported", async () => {
  const r = repo({ "src/lib/collections.js": groupBy, "src/billing/invoice.ts": invoice });
  r.write({ "src/reports/rows.js": bucketRows, "src/billing/bill.ts": bill });
  const { code, out } = await run(r.cwd, ["similar"]);
  assert.equal(code, 1);
  assert.deepEqual(out, [
    `src/billing/bill.ts:1 Bill is 100% the same as src/billing/invoice.ts:1 Invoice: use one type${accept("src/billing/bill.ts:Bill")}`,
    `src/reports/rows.js:1 bucketRows is 100% the same as src/lib/collections.js:1 groupBy: reuse it${accept("src/reports/rows.js:bucketRows")}`,
  ]);
});

test("a different component of the same size is not reported", async () => {
  const r = repo({ "src/components/ProfileCard.jsx": profileCard });
  r.write({ "src/components/SignupForm.jsx": signupForm });
  const { code, out } = await run(r.cwd, ["similar"]);
  assert.equal(code, 0);
  assert.deepEqual(out, ["ok gate similar: 1 added units checked against 2 units"]);
});

test("an exact pasted block is left to the duplicates gate", async () => {
  const r = repo({ "src/lib/collections.js": groupBy });
  r.write({ "src/reports/group.js": `// pasted\n${groupBy.replace("groupBy", "groupRows")}` });
  assert.equal((await run(r.cwd, ["duplicates"])).code, 1);
  assert.equal((await run(r.cwd, ["similar"])).code, 0);
});

test("a unit moved to another file in the same change is not a duplicate", async () => {
  const r = repo({ "src/lib/collections.js": `${groupBy}\nexport const one = 1;\n` });
  r.write({ "src/lib/collections.js": "export const one = 1;\n", "src/lib/group.js": bucketRows });
  assert.equal((await run(r.cwd, ["similar"])).code, 0);
});

test("tests, kit primitives, route shells and tiny units are not reported", async () => {
  const r = repo({
    "src/lib/collections.js": groupBy,
    "src/lib/math.js": "export const add = (a, b) => a + b;\n",
    "src/components/ui/button.jsx": button("Button", "rounded-md bg-blue-600 px-4 py-2 text-white"),
    "app/settings/page.jsx": page("Settings"),
  });
  r.write({
    "src/lib/collections.test.js": bucketRows,
    "src/lib/sum.js": "export const sum = (x, y) => x + y;\n",
    "src/components/ui/toggle.jsx": button("Toggle", "rounded-md bg-gray-100 px-4 py-2 text-black"),
    "app/billing/page.jsx": page("Billing"),
  });
  const { code, out } = await run(r.cwd, ["similar"]);
  assert.equal(code, 0, out.join("\n"));
});

test("an acknowledged target is not reported", async () => {
  const r = repo({ "src/lib/collections.js": groupBy }, { acknowledged: [{ gate: "similar", target: "src/reports/rows.js:bucketRows", why: "kept apart on purpose" }] });
  r.write({ "src/reports/rows.js": bucketRows });
  assert.equal((await run(r.cwd, ["similar"])).code, 0);
});

test("a copy added to a tracked file without committing is seen", async () => {
  const r = repo({ "src/lib/collections.js": groupBy, "src/reports/rows.js": "export const rows = [];\n" });
  r.write({ "src/reports/rows.js": `export const rows = [];\n\n${bucketRows}` });
  const { code, out } = await run(r.cwd, ["similar"]);
  assert.equal(code, 1);
  assert.match(out[0], /^src\/reports\/rows\.js:3 bucketRows is 100% the same as src\/lib\/collections\.js:1 groupBy/);
});

test("checks a change against 4,000 files and reports its CPU time", async (t) => {
  /** @type {Record<string, string>} */
  const files = {};
  const calls = ["fetchOrders", "loadUsers", "readConfig", "parseInput", "sendMail", "openFile", "scoreLead", "logEvent"];
  for (let i = 0; i < 4000; i++) {
    const steps = Array.from({ length: 4 + (i % 9) }, (_, j) => `  const v${j} = ${calls[(i + j) % 8]}(input.p${i}x${j}, ${j});\n  if (v${j} ${j % 2 ? ">" : "==="} ${i}) return v${j};`).join("\n");
    files[`src/m${Math.floor(i / 100)}/f${i}.ts`] = `import { ${calls.join(", ")} } from "../lib";\n\nexport function f${i}(input) {\n${steps}\n  return null;\n}\n`;
  }
  const r = repo(files);
  t.after(() => rmSync(r.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  r.write({ "src/new.ts": files["src/m12/f1234.ts"].replace("f1234", "copied").replace(/v(\d)/g, "w$1") });
  // Printed, not asserted: on a saturated machine even CPU time swings several-fold, and a real blow-up shows as a timeout.
  const started = process.cpuUsage();
  const { code, out } = await run(r.cwd, ["similar"]);
  const used = process.cpuUsage(started);
  const ms = (used.user + used.system) / 1000;
  console.error(`similar on 4,000 files: ${Math.round(ms)}ms`);
  assert.equal(code, 1);
  assert.match(out[0], /^src\/new\.ts:3 copied is 100% the same as src\/m12\/f1234\.ts:3 f1234: reuse it/);
});
