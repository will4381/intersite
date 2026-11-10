// @ts-check
import { defineRule } from "@oxlint/plugins";

import { bindings, words } from "./names.mjs";

/**
 * Abbreviations that save a few letters and cost every reader a decode. The idiomatic ones (id, url, ctx, req, res,
 * err, fn, cb, el, i) are not here.
 */
const SHORT = { usr: "user", mgr: "manager", mngr: "manager", cfg: "config", btn: "button", msg: "message", cnt: "count", pwd: "password", svc: "service", ctrl: "controller", tbl: "table", lbl: "label", txt: "text", lst: "list", nxt: "next", amt: "amount", qty: "quantity", addr: "address", obj: "object", arr: "array", str: "string", hndlr: "handler", acct: "account", tmp: "temp", calc: "calculate", usrs: "users", msgs: "messages", btns: "buttons" };

export const id = "no-abbreviation-soup";
export const pack = "naming";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      found: "{{name}} is mostly abbreviations ({{short}}), so every reader has to decode it. Spell the words out: {{fixed}}.",
    },
  },
  createOnce(context) {
    return bindings((id, how) => {
      if (how === "destructured") return;
      const parts = words(id.name);
      const short = parts.filter((w) => Object.hasOwn(SHORT, w.toLowerCase()));
      if (short.length < 2 || short.length * 2 < parts.length) return;
      const fixed = parts.map((w, i) => {
        const long = SHORT[/** @type {keyof typeof SHORT} */ (w.toLowerCase())] ?? w.toLowerCase();
        return i === 0 && /^[a-z]/.test(id.name) ? long : long[0].toUpperCase() + long.slice(1);
      }).join("");
      context.report({ node: id, messageId: "found", data: { name: id.name, short: short.join(", "), fixed } });
    });
  },
});

export const bad = [
  "export const usrMgr = createManager();",
  "export const cfgObj = load();",
  "export function sendMsg(usrAddr: string, msgTxt: string) { return [usrAddr, msgTxt]; }",
];

export const good = [
  "export const userManager = createManager();",
  "export const reqCtx = { req, res };",
  "export const cfg = load();",
  "export const totalMsgCount = count();",
];
