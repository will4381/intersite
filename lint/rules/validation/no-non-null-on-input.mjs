// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, isEnvRead, isParamGet, isStorageRead, notShipped, receiverName } from "../shared.mjs";

const MOUNT = /^(createRoot|hydrateRoot|render|hydrate|mount)$/;

/**
 * What a `!` asserts present, when that thing really can be absent at runtime: "" otherwise. Map lookups and `.at(-1)`
 * after a length check are left to the author: they are usually built a line above.
 * @param {any} node the asserted expression
 */
function absentable(node) {
  if (isEnvRead(node)) return "env";
  if (node.type !== "CallExpression") return "";
  const name = calleeName(node);
  if (name === "get" && receiverName(node) === "env") return "env"; // Deno.env.get('X')
  if (isParamGet(node) || isStorageRead(node) || (name === "get" && receiverName(node) === "headers")) return "input";
  // TABLE.find(...) over a module constant is keyed by a value the compiler has already narrowed to the table's keys.
  if (name === "find" || name === "findLast") return /^[A-Z][A-Z0-9_]*$/.test(receiverName(node)) ? "" : "find";
  // document.getElementById('root')! handed straight to createRoot fails on the first page load, where it is seen.
  if (/^(getElementById|querySelector)$/.test(name)) return MOUNT.test(calleeName(node.parent?.parent)) ? "" : "dom";
  return "";
}

export const id = "no-non-null-on-input";
export const pack = "types";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      env: "`!` claims this environment variable is set; when a deploy forgets it, the code runs on with undefined and fails somewhere else. Read the environment once in a config module that validates it at startup (zod, envalid, t3-env), or check it here and throw an error naming the variable.",
      input: "`!` claims this request, URL, header or storage value is present, but the client decides that. Check it and answer 400 (or fall back on purpose) when it is missing.",
      find: "`!` claims find() matched, and when it does not the next line throws a TypeError with no context. Check the result and throw an error that names what was missing, or return early.",
      dom: "`!` claims this element exists; a renamed id or a conditional render makes it null and the next line throws. Check it and handle the missing element, or use a ref.",
    },
  },
  createOnce(context) {
    return {
      before: () => !notShipped(context),
      TSNonNullExpression(node) {
        let inner = /** @type {any} */ (node.expression);
        while (inner.type === "ParenthesizedExpression") inner = inner.expression;
        const kind = absentable(inner);
        if (kind) context.report({ node, messageId: kind });
      },
    };
  },
});

export const bad = [
  "const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);",
  "const url = import.meta.env.VITE_API_URL!;",
  "const supabase = createClient(Deno.env.get('SUPABASE_URL')!, key);",
  "const token = url.searchParams.get('token')!;",
  "const owner = users.find((u) => u.id === ownerId)!;",
  "const canvas = document.getElementById('chart')!; canvas.addEventListener('click', open);",
  "const draft = JSON.parse(localStorage.getItem('draft')!);",
  "const signature = request.headers.get('stripe-signature')!;",
];

export const good = [
  "createRoot(document.getElementById('root')!).render(<App />);",
  "const pet = petById.get(row.petId)!;",
  "const last = rows.at(-1)!.id;",
  "const key = process.env.STRIPE_SECRET_KEY; if (!key) throw new Error('STRIPE_SECRET_KEY is not set');",
  "const owner = users.find((u) => u.id === ownerId); if (!owner) throw new Error(`no owner ${ownerId}`);",
  "const token = url.searchParams.get('token') ?? '';",
  "const value = ref.current!.value;",
  "const rail = SUPPORTED_COUNTRIES.find((c) => c.code === code)!.rail;",
];

export const ext = "tsx";
