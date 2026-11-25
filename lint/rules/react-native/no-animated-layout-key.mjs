// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isHookCall } from "../react/hooks.mjs";
import { FUNCTIONS, mentions, unwrap, walk } from "../shared.mjs";

const NEEDS = /useAnimatedStyle/;
/**
 * Style keys that change layout. Reanimated applies transform, opacity, colours, radii and shadows to the view; a key
 * here makes React Native lay the view and the views around it out again on every frame its value changes. `display`
 * and `position` are left out: they switch a layout, they do not animate one.
 */
const LAYOUT = /^(?:width|height|(?:min|max)(?:Width|Height)|top|bottom|left|right|start|end|inset\w*|margin\w*|padding\w*|flex|flexBasis|flexGrow|flexShrink|gap|rowGap|columnGap|fontSize|lineHeight|letterSpacing|border\w*Width|aspectRatio)$/;

/** A value that is the same on every frame: a literal, `undefined`, or a template with nothing in it. @param {any} node */
const constant = (node) =>
  node.type === "Literal" || (node.type === "Identifier" && node.name === "undefined") || (node.type === "TemplateLiteral" && !node.expressions.length) || (node.type === "UnaryExpression" && node.argument.type === "Literal");

/** The objects an expression can evaluate to: through casts, both sides of `?:`, and `&&`/`||`/`??`. @param {any} node @param {any[]} out */
function objects(node, out = []) {
  node = unwrap(node);
  if (node?.type === "ObjectExpression") out.push(node);
  if (node?.type === "ConditionalExpression") for (const branch of [node.consequent, node.alternate]) objects(branch, out);
  if (node?.type === "LogicalExpression") for (const side of [node.left, node.right]) objects(side, out);
  return out;
}

/** What the worklet returns: its expression body, or every `return` that is its own (not a nested function's). @param {any} fn */
function returns(fn) {
  if (fn.body.type !== "BlockStatement") return objects(fn.body);
  /** @type {any[]} */
  const out = [];
  walk(fn.body, (n) => {
    if (n !== fn.body && FUNCTIONS.has(n.type)) return false;
    if (n.type === "ReturnStatement" && n.argument) objects(n.argument, out);
  });
  return out;
}

export const id = "no-animated-layout-key";
export const pack = "react-native";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      layout: "{{keys}} in an animated style {{verb}} layout, so React Native lays this view and the views around it out again on every frame of the animation. Move it with `transform` (translateX, translateY, scale) and `opacity`, which change no layout; for a size that has to change, measure it once and scale it.",
    },
  },
  createOnce(context) {
    return {
      before: () => mentions(context, NEEDS),
      CallExpression(/** @type {any} */ node) {
        const worklet = node.arguments[0];
        if (!isHookCall(node, /^useAnimatedStyle$/) || !FUNCTIONS.has(worklet?.type)) return;
        for (const style of returns(worklet)) {
          const moving = style.properties.filter((/** @type {any} */ p) => p.type === "Property" && !p.computed && LAYOUT.test(p.key.name ?? p.key.value ?? "") && !constant(unwrap(p.value)));
          const keys = moving.map((/** @type {any} */ p) => `\`${p.key.name ?? p.key.value}\``);
          if (moving.length) context.report({ node: moving[0], messageId: "layout", data: { keys: keys.length > 1 ? `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}` : keys[0], verb: keys.length > 1 ? "change" : "changes" } });
        }
      },
    };
  },
});

export const bad = [
  "export const useGrow = (progress: { value: number }) => useAnimatedStyle(() => ({ height: progress.value * 200 }));",
  "export function useSlide(offset: { value: number }) {\n  return useAnimatedStyle(() => {\n    return { top: offset.value, opacity: 1 };\n  });\n}",
  "export const usePanel = (open: { value: number }, measured: number) =>\n  Reanimated.useAnimatedStyle(() => (measured ? { maxHeight: open.value * measured } : {}));",
  "export function useLabel(focus: { value: number }) {\n  return useAnimatedStyle(() => {\n    if (!focus.value) return { fontSize: 16 };\n    return { fontSize: withTiming(focus.value ? 12 : 16) };\n  });\n}",
  "export const useBar = (w: { value: number }) => useAnimatedStyle(() => ({ width: `${w.value * 100}%` }) as const);",
];

export const good = [
  "export const useSlide = (offset: { value: number }, progress: { value: number }) =>\n  useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }], opacity: progress.value }));",
  "export const useTint = (color: { value: string }) => useAnimatedStyle(() => ({ backgroundColor: color.value, borderRadius: 12 }));",
  // The same on every frame: only the opacity moves.
  "export const useFade = (progress: { value: number }) => useAnimatedStyle(() => ({ height: 40, marginTop: undefined, opacity: progress.value }));",
  // A style that is not animated may set any key.
  "export const card = { height: 200, marginTop: 8 };",
  // A nested function's object is not the style.
  "export const useScale = (s: { value: number }) => useAnimatedStyle(() => {\n  const size = () => ({ width: s.value });\n  return { transform: [{ scale: s.value }], opacity: size().width ? 1 : 0 };\n});",
];
