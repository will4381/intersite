// @ts-check
import { defineRule } from "@oxlint/plugins";

/**
 * A whole message that only marks "the code got here": `here`, `test`, `HERE!!!`, `got here`, `asdf`, `1`. Not `ok` or a
 * line of `=====`: a script's last line and its output headings are real output.
 */
const marker = /^\s*(?:here|in here|got here|reached(?: here)?|test(?:ing)?|hi|hello|asdf\w*|qwe\w*|foo|bar|x+|y+|\d+|yay|works|it works|wtf|hmm+|lol)\s*[!.:?]*\s*$/i;
/** A debug tag at the start: `DEBUG user`, `[debug]`, `debug:`. (`--- RESULTS ---` is often a script's real output heading.) */
const tag = /^\s*(?:DEBUG\b|\[debug\]|debug:)/;
/** A message opening with an emoji, as generated code tends to write them: `🚀 Server started`, `✅ Saved`. */
const emoji = /^\s*\p{Extended_Pictographic}/u;

export const id = "no-debug-log";
export const pack = "slop";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      marker: "This log only marks that the code ran (\"{{text}}\"); it is a debugging leftover that tells nobody anything. Delete it, or log the event and the values that matter.",
      emoji: "This log message opens with an emoji, a tell of generated code that makes logs harder to search and parse. Start with the event in words (\"server started on :3000\").",
      debugger: "Logging a bare value next to a `debugger` statement is a debugging session left in the code. Delete both.",
    },
  },
  createOnce(context) {
    let hasDebugger = false;
    /** @type {any[]} console.log(x) calls with one bare identifier */
    let bare = [];
    return {
      before() {
        hasDebugger = false;
        bare = [];
      },
      DebuggerStatement() {
        hasDebugger = true;
      },
      "CallExpression[callee.object.name='console']"(node) {
        const method = node.callee.property?.name;
        const [first, ...rest] = node.arguments;
        const text = first?.type === "Literal" && typeof first.value === "string" ? first.value : first?.type === "TemplateLiteral" ? first.quasis[0].value.cooked ?? "" : undefined;
        if (text !== undefined && emoji.test(text)) return context.report({ node, messageId: "emoji" });
        if (method !== "log" && method !== "debug") return;
        if (text !== undefined && (tag.test(text) || (!rest.length && first.type === "Literal" && marker.test(text)))) return context.report({ node, messageId: "marker", data: { text: text.trim().slice(0, 30) } });
        if (first?.type === "Identifier" && !rest.length) bare.push(node);
      },
      "Program:exit"() {
        if (hasDebugger) for (const node of bare) context.report({ node, messageId: "debugger" });
      },
    };
  },
});

export const bad = [
  "export function save() { console.log('here'); return 1; }",
  "export function load(user) { console.log('DEBUG user', user); return user; }",
  "export function start() { console.log('🚀 Server started on port 3000'); }",
  "export function save(state) { console.log(state); debugger; return state; }",
  "export function f() { console.log('test'); }",
];

export const good = [
  "export function start(port) { console.log(`listening on :${port}`); }",
  "export function save(id) { console.info('saved order', id); }",
  "export function report(rows) { console.log(rows); }",
  "export function warn() { console.warn('Retrying after a 429 from the payments API'); }",
  "export function f() { console.log('test suite finished'); }",
  "export function main() { run(); console.log('ok'); }",
];
