// @ts-check
import { defineRule } from "@oxlint/plugins";

/** Files a project marks as holding money arithmetic: `*.money.ts`. */
const MONEY_FILE = /\.money\.[cm]?[jt]s$/;
const ROUNDING = /^(round|floor|ceil|trunc)$/;

export const id = "no-float-money";
export const pack = "payments";
export const ext = "money.ts";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      fraction: "A fractional number in a .money. file is a float, and floats cannot hold most decimal amounts exactly (0.1 + 0.2 !== 0.3). Keep amounts in integer minor units (cents) or bigint, and rates in integer basis points.",
      rounding: "Math.{{name}} in a .money. file rounds here and differently somewhere else, so the same amount comes out a cent apart on two paths. Round in one shared money helper and call it.",
      parse: "{{name}} in a .money. file turns an amount into a float or a float into text. Parse and format amounts with one shared money helper that works in integer minor units.",
    },
  },
  createOnce(context) {
    return {
      before: () => MONEY_FILE.test(context.filename),
      Literal(node) {
        if (typeof node.value === "number" && !Number.isInteger(node.value)) context.report({ node, messageId: "fraction" });
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        const name = callee.type === "Identifier" ? callee.name : callee.property?.name;
        if (callee.object?.name === "Math" && ROUNDING.test(name)) context.report({ node, messageId: "rounding", data: { name } });
        else if (name === "parseFloat" || (name === "toFixed" && callee.type === "MemberExpression")) context.report({ node, messageId: "parse", data: { name } });
      },
    };
  },
});

export const bad = [
  "export const fee = (cents: number) => cents * 0.029;",
  "export const toCents = (dollars: number) => Math.round(dollars * 100);",
  "export const parseAmount = (text: string) => parseFloat(text);",
  "export const label = (dollars: number) => dollars.toFixed(2);",
  "export const half = (cents: number) => Math.floor(cents / 2);",
];

export const good = [
  "export const FEE_BPS = 290;\nexport const fee = (cents: bigint) => (cents * BigInt(FEE_BPS)) / 10_000n;",
  "import { roundHalfEven } from './rounding.money.js';\nexport const half = (cents: bigint) => roundHalfEven(cents, 2n);",
  "export const total = (lines: { cents: number }[]) => lines.reduce((sum, line) => sum + line.cents, 0);",
];
