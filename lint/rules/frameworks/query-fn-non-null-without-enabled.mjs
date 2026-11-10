// @ts-check
import { defineRule } from "@oxlint/plugins";

import { walk } from "../shared.mjs";

export const id = "query-fn-non-null-without-enabled";
export const pack = "query";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      enabled: "The queryFn asserts `{{value}}` is set with `!`, but nothing stops the query from running while it is undefined, so the first render fetches `.../undefined` (or throws) and caches that result. Add `enabled: {{value}} != null` (or pass `skipToken` as the queryFn while it is missing) and drop the `!`.",
    },
  },
  createOnce(context) {
    return {
      ObjectExpression(node) {
        const props = /** @type {any[]} */ (node.properties);
        const fn = props.find((p) => p.type === "Property" && p.key?.name === "queryFn")?.value;
        if (!fn?.type.endsWith("FunctionExpression") || !props.some((p) => p.type === "Property" && p.key?.name === "queryKey")) return;
        if (props.some((p) => p.type === "SpreadElement" || p.key?.name === "enabled")) return;
        if (context.sourceCode.getText(node).includes("skipToken")) return;
        /** @type {any} */
        let found;
        walk(fn.body, (n) => {
          if (n.type.endsWith("FunctionExpression")) return false; // A callback inside runs later, under its own checks.
          if (!found && n.type === "TSNonNullExpression" && ["Identifier", "MemberExpression"].includes(n.expression.type)) found = n;
        });
        if (!found) return;
        const value = context.sourceCode.getText(found.expression);
        context.report({ node: found, messageId: "enabled", data: { value } });
      },
    };
  },
});

export const bad = [
  "export function useProfile(userId?: string) {\n  return useQuery({ queryKey: ['profile', userId], queryFn: () => getProfile(userId!) });\n}",
  "export function Team({ org }: { org?: Org }) {\n  const { data } = useQuery({ queryKey: ['team', org?.id], queryFn: async () => (await fetch(`/api/teams/${org!.id}`)).json() });\n  return <List items={data} />;\n}",
  "export const useInvoice = (id: string | undefined) =>\n  useSuspenseQuery({ queryKey: ['invoice', id], queryFn: () => api.invoice(id!) });",
];

export const good = [
  "export function useProfile(userId?: string) {\n  return useQuery({ queryKey: ['profile', userId], queryFn: () => getProfile(userId!), enabled: !!userId });\n}",
  "export function useProfile(userId?: string) {\n  return useQuery({ queryKey: ['profile', userId], queryFn: userId ? () => getProfile(userId) : skipToken });\n}",
  "export function useProfile(userId: string) {\n  return useQuery({ queryKey: ['profile', userId], queryFn: () => getProfile(userId) });\n}",
  "export function useRows(opts: Opts) {\n  return useQuery({ ...opts, queryKey: ['rows'], queryFn: () => load(ref.current!) });\n}",
];
