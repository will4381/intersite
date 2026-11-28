// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isHookCall } from "../react/hooks.mjs";
import { FUNCTIONS, calleeName, mentions, unwrap, walk } from "../shared.mjs";

const NEEDS = /useAnimatedStyle/;
/**
 * Style keys that change layout. Reanimated applies transform, opacity, colours, radii and shadows to the view; a key
 * here makes React Native lay the view and the views around it out again on every frame its value changes. `display`
 * and `position` are left out: they switch a layout, they do not animate one.
 */
const LAYOUT = /^(?:width|height|(?:min|max)(?:Width|Height)|top|bottom|left|right|start|end|inset\w*|margin\w*|padding\w*|flex|flexBasis|flexGrow|flexShrink|gap|rowGap|columnGap|fontSize|lineHeight|letterSpacing|border\w*Width|aspectRatio)$/;

/**
 * Whether a value changes from frame to frame: it reads a shared value (`.value`, `.get()`), calls an animation
 * (`withTiming`, `withSpring`…) or `interpolate`, or names a `const` of the worklet that does (`const h = base +
 * resize.value`). A constant, a prop or a value from render is the same on every frame.
 * @param {any} node @param {Map<string, any>} locals the worklet's own consts and what each is set to
 * @param {Set<string>} [seen]
 */
function moves(node, locals, seen = new Set()) {
  let found = false;
  walk(node, (n, parent) => {
    if (found) return false;
    const read = n.type === "MemberExpression" && !n.computed && n.property.name === "value";
    const got = n.type === "CallExpression" && !n.arguments.length && n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.property.name === "get";
    // A name as a key or after a dot is not a reference to the const.
    const named = n.type === "Identifier" && locals.has(n.name) && !seen.has(n.name) && !(parent?.type === "MemberExpression" && parent.property === n && !parent.computed) && !(parent?.type === "Property" && parent.key === n && !parent.shorthand);
    if (named) seen.add(n.name);
    found = read || got || /^(?:with[A-Z]\w*|interpolate)$/.test(calleeName(n)) || (named && moves(locals.get(n.name), locals, seen));
  });
  return found;
}

/** The consts a worklet declares in its own body (not a nested function's), by name. @param {any} fn */
function localConsts(fn) {
  /** @type {Map<string, any>} */
  const out = new Map();
  if (fn.body.type !== "BlockStatement") return out;
  walk(fn.body, (n) => {
    if (n !== fn.body && FUNCTIONS.has(n.type)) return false;
    if (n.type === "VariableDeclaration" && n.kind === "const") for (const d of n.declarations) if (d.id.type === "Identifier" && d.init) out.set(d.id.name, d.init);
  });
  return out;
}

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
        const locals = localConsts(worklet);
        for (const style of returns(worklet)) {
          const moving = style.properties.filter((/** @type {any} */ p) => p.type === "Property" && !p.computed && LAYOUT.test(p.key.name ?? p.key.value ?? "") && moves(p.value, locals));
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
  // A value worked out a line earlier, Reanimated's .get(), and a helper given a value from a shared value.
  "export function useBlock(height: number, resize: { value: number }, top: number) {\n  return useAnimatedStyle(() => {\n    const liveHeight = height + resize.value;\n    return { top, height: liveHeight };\n  });\n}",
  "export const usePad = (resting: number, progress: { get(): number }) => useAnimatedStyle(() => ({ paddingBottom: 10 + (resting - 10) * (1 - progress.get()) }));",
  "export function usePill(from: number, to: number, x: { value: number }) {\n  return useAnimatedStyle(() => {\n    const f = Math.min(1, Math.max(0, x.value));\n    return { left: lerp(from, to, f) };\n  });\n}",
];

export const good = [
  "export const useSlide = (offset: { value: number }, progress: { value: number }) =>\n  useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }], opacity: progress.value }));",
  "export const useTint = (color: { value: string }) => useAnimatedStyle(() => ({ backgroundColor: color.value, borderRadius: 12 }));",
  // The same on every frame: only the opacity moves.
  "export const useFade = (progress: { value: number }) => useAnimatedStyle(() => ({ height: 40, marginTop: undefined, opacity: progress.value }));",
  "export const useHeader = (y: { value: number }) => useAnimatedStyle(() => ({ height: HEADER, transform: [{ translateY: y.value }] }));",
  "export const useDrawer = (open: boolean, y: { value: number }) => useAnimatedStyle(() => ({ height: open ? 200 : 0, opacity: y.value }), [open]);",
  "export const useCell = (w: number, y: { value: number }) => useAnimatedStyle(() => ({ width: w, opacity: y.value }));",
  // A const of the worklet that is the same on every frame, and one that moves only the transform.
  "export function useRow(width: number, x: { value: number }) {\n  return useAnimatedStyle(() => {\n    const w = width * 2;\n    const dx = x.value;\n    return { transform: [{ translateX: dx }], width: w };\n  });\n}",
  // A style that is not animated may set any key.
  "export const card = { height: 200, marginTop: 8 };",
  // A nested function's object is not the style.
  "export const useScale = (s: { value: number }) => useAnimatedStyle(() => {\n  const size = () => ({ width: s.value });\n  return { transform: [{ scale: s.value }], opacity: size().width ? 1 : 0 };\n});",
];
