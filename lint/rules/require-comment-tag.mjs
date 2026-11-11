// @ts-check
import { commentRule } from "../comment-rule.mjs";
import { isGenerated } from "./shared.mjs";

/**
 * A comment's first line may open with a tag saying why it exists, or be a directive a tool reads: a reasoned lint or
 * type suppression, a bundler or coverage hint, a triple-slash reference, a JSDoc type, a source map or a licence.
 * Case-sensitive: `Safety: ...` is prose, not the tag.
 */
const TAGGED = new RegExp(
  "^(?:SAFETY:|PROVIDER:|ponytail:" +
    "|@ts-expect-error \\S|@ts-check\\b|(?:eslint|oxlint)-disable(?:-next-line|-line)? \\S+.* -- \\S|(?:eslint|oxlint)-enable\\b" +
    "|prettier-ignore\\b|biome-ignore \\S|(?:c8|v8|istanbul) ignore\\b|[#@]__PURE__|@vite-ignore|webpack[A-Z]\\w*:|(?:/ *)?<reference |@jsx(?:ImportSource)? |@refresh reset" +
    "|@(?:type|typedef|param|returns?|template|import|satisfies|callback|property|overload|this|enum)\\b|[#@] source(?:Mapping)?URL=|@license\\b|@preserve\\b|!)",
);

export const id = "require-comment-tag";
export const pack = "comments";

export const rule = commentRule(
  "This comment has no tag. Say it with a clearer name, a smaller function or a test instead. If it truly cannot be said in code, start it with SAFETY: (an invariant the code relies on), PROVIDER: (how an outside service behaves) or ponytail: (a known limit and its upgrade path).",
  (first) => !TAGGED.test(first),
  (context) => !isGenerated(context),
);

export const bad = [
  "// Loop over the users and save each one\nfor (const user of users) save(user);",
  "/**\n * Returns the user's display name.\n */\nexport const displayName = (user: User) => user.name;",
  "// Safety: the list is never empty here\nexport const first = (items: string[]) => items[0];",
  "// oxlint-disable-next-line no-console\nconsole.log(total);",
];

export const good = [
  "// SAFETY: validate() ran above, so every row has an id\nexport const ids = (rows: Row[]) => rows.map((row) => row.id);",
  "// PROVIDER: Stripe sends amounts in the smallest currency unit\nexport const cents = (event: StripeEvent) => event.data.object.amount;",
  "// ponytail: linear scan, index by id once lists pass 1,000 rows\nexport const find = (rows: Row[], id: string) => rows.find((row) => row.id === id);",
  "// oxlint-disable-next-line no-console -- the CLI prints its result\nconsole.log(total);",
  "// @ts-expect-error the old signature is still exported for one release\nlegacy(1);",
  "/// <reference types=\"vite/client\" />\nexport const mode = import.meta.env.MODE;",
  "/** @type {import('./types').Config} */\nexport const config = { port: 3000 };",
  "export const lazy = () => import(/* @vite-ignore */ url);",
  "#!/usr/bin/env node\nexport const run = () => main(process.argv);",
];
