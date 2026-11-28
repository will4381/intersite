// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isHookCall, stateSetters } from "../react/hooks.mjs";
import { FUNCTIONS, calleeName, constInit, mentions, resolveVariable, returned, unwrap } from "../shared.mjs";

const NEEDS = /onScroll|useAnimatedScrollHandler/;
/** A React Native file: on the web a scroll handler has neither shared values nor useAnimatedScrollHandler. */
const NATIVE = /react-native|reanimated|flash-list/;
/** Statements and expressions that run what is under them only some of the time. */
const BRANCHES = new Set(["IfStatement", "ConditionalExpression", "LogicalExpression", "SwitchStatement"]);
/** React Native's scrolling components, whose `onScroll` gets a scroll event (`Animated.ScrollView` too). */
const SCROLLERS = /(?:ScrollView|FlatList|SectionList|FlashList|VirtualizedList)$/;

/** The function a handler expression is: inline, a `const` holding one or `useCallback(fn)`, or a function declaration. @param {any} node @param {any} sourceCode */
function handlerFunction(node, sourceCode) {
  node = unwrap(node);
  if (FUNCTIONS.has(node?.type)) return node;
  if (node?.type !== "Identifier") return undefined;
  const init = unwrap(constInit(node, sourceCode));
  if (FUNCTIONS.has(init?.type)) return init;
  if (isHookCall(init, /^useCallback$/) && FUNCTIONS.has(init.arguments[0]?.type)) return init.arguments[0];
  const declared = resolveVariable(node, sourceCode)?.defs[0]?.node;
  return declared?.type === "FunctionDeclaration" ? declared : undefined;
}

/**
 * Whether an identifier names the setter of a `useState` (`const [v, setV] = useState()`). A reducer's `dispatch` is
 * not one: the reducer decides what changes, and handing back the same state skips the render.
 * @param {any} node @param {any} sourceCode
 */
function isStateSetter(node, sourceCode) {
  if (node?.type !== "Identifier") return false;
  const fn = resolveVariable(node, sourceCode)?.defs[0]?.node?.parent?.parent?.parent;
  return FUNCTIONS.has(fn?.type) && stateSetters(fn).has(node.name);
}

/**
 * The setter a call reaches and the value it sets: `setV(x)`, or from a worklet `runOnJS(setV)(x)` and
 * `scheduleOnRN(setV, x)`.
 * @param {any} call @returns {[any, any]}
 */
function setterOf(call) {
  if (call.callee.type === "CallExpression" && calleeName(call.callee) === "runOnJS") return [call.callee.arguments[0], call.arguments[0]];
  if (calleeName(call) === "scheduleOnRN") return [call.arguments[0], call.arguments[1]];
  return [call.callee, call.arguments[0]];
}

/**
 * Whether a value changes only at a threshold, so most events set what is already there and React skips the render:
 * a comparison, a negation, a literal, a `Boolean(...)`, an index (`Math.round(x / width)`), a predicate's answer
 * (`isNear(...)`), a choice between such values, or an updater function that returns one or the state it was given
 * (`(now) => (now === at ? now : at)`: handing back the same state skips the render).
 * @param {any} node @param {any} sourceCode @param {number} [depth] @param {string} [previous] an updater's parameter
 * @returns {boolean}
 */
function discrete(node, sourceCode, depth = 0, previous = undefined) {
  node = unwrap(node);
  if (!node || node.type === "Literal") return true;
  // ponytail: an updater with more than a `return` in its body is left alone; walking its returns would judge it.
  if (FUNCTIONS.has(node.type)) return discrete(returned(node), sourceCode, depth, node.params[0]?.type === "Identifier" ? node.params[0].name : undefined);
  if (node.type === "Identifier" && node.name === previous) return true;
  if (node.type === "TemplateLiteral") return !node.expressions.length;
  if (node.type === "BinaryExpression") return /^(?:[<>]=?|[!=]==?|in|instanceof)$/.test(node.operator);
  if (node.type === "UnaryExpression") return node.operator === "!";
  if (node.type === "LogicalExpression") return discrete(node.left, sourceCode, depth, previous) && discrete(node.right, sourceCode, depth, previous);
  if (node.type === "ConditionalExpression") return discrete(node.consequent, sourceCode, depth, previous) && discrete(node.alternate, sourceCode, depth, previous);
  if (node.type === "CallExpression") {
    const name = calleeName(node);
    if (/^(?:round|floor|ceil|trunc)$/.test(name) && node.callee.object?.name === "Math") {
      const arg = unwrap(node.arguments[0]);
      return arg?.type === "BinaryExpression" && arg.operator === "/";
    }
    // ponytail: a predicate is known by its name; type-aware lint could ask whether the call returns a boolean.
    return /^(?:is|has|should|can)[A-Z]/.test(name) || (node.callee.type === "Identifier" && name === "Boolean");
  }
  if (node.type !== "Identifier" || depth > 1) return false;
  const init = constInit(node, sourceCode);
  return init !== undefined && discrete(init, sourceCode, depth + 1);
}

/** Whether a statement ends the handler early (`if (done) return;`), which makes everything after it a threshold. @param {any} node */
const returnsEarly = (node) => node.type === "ReturnStatement" || (node.type === "BlockStatement" && node.body.some((/** @type {any} */ s) => s.type === "ReturnStatement"));

/**
 * The state setters a handler calls every time it runs: not under a branch or after an early return, and not inside a
 * nested function (a debounce sets state once the scroll has stopped).
 * @param {any} node @param {boolean} branched @param {any[]} out @param {any} sourceCode
 */
function unconditionalSets(node, branched, out, sourceCode) {
  if (!node || typeof node.type !== "string" || FUNCTIONS.has(node.type)) return out;
  if (node.type === "CallExpression" && !branched) {
    const [setter, value] = setterOf(node);
    if (isStateSetter(setter, sourceCode) && !discrete(value, sourceCode)) out.push(node);
  }
  if (node.type === "BlockStatement") {
    let after = branched;
    for (const s of node.body) {
      unconditionalSets(s, after, out, sourceCode);
      if (s.type === "IfStatement" && returnsEarly(s.consequent)) after = true;
    }
    return out;
  }
  const inside = branched || BRANCHES.has(node.type);
  for (const key in node) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const v of value) unconditionalSets(v, inside, out, sourceCode);
    else if (value && typeof value === "object") unconditionalSets(value, inside, out, sourceCode);
  }
  return out;
}

export const id = "no-state-per-scroll-event";
export const pack = "react-native";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      scroll: "This sets React state to a new value on every scroll event, so the component renders again for every frame of the scroll. Keep the position in a ref, or in a shared value with useAnimatedScrollHandler, and set state only to what is drawn from it (a boolean or an index: while it stays the same, React skips the render).",
    },
  },
  createOnce(context) {
    /** @param {any} handler */
    const judge = (handler) => {
      if (!handler) return;
      for (const call of unconditionalSets(handler.body, false, [], context.sourceCode)) context.report({ node: call, messageId: "scroll" });
    };
    return {
      // react-native-web renders a .web file in the browser, where a scroll is the page's.
      before: () => !/\.web\.[cm]?[jt]sx?$/.test(context.filename) && mentions(context, NEEDS) && mentions(context, NATIVE),
      JSXAttribute(/** @type {any} */ node) {
        if (node.name.name !== "onScroll" || node.value?.type !== "JSXExpressionContainer") return;
        const handler = handlerFunction(node.value.expression, context.sourceCode);
        // Another component's `onScroll` may hand over anything (a carousel's index): only a scroll event is this rule's.
        const element = context.sourceCode.getText(node.parent.name);
        if (handler && (SCROLLERS.test(element) || /\b(?:nativeEvent|contentOffset)\b/.test(context.sourceCode.getText(handler)))) judge(handler);
      },
      CallExpression(/** @type {any} */ node) {
        if (!isHookCall(node, /^useAnimatedScrollHandler$/)) return;
        const arg = unwrap(node.arguments[0]);
        if (FUNCTIONS.has(arg?.type)) return judge(arg);
        const onScroll = arg?.type === "ObjectExpression" && arg.properties.find((/** @type {any} */ p) => p.key?.name === "onScroll");
        if (onScroll) judge(FUNCTIONS.has(onScroll.value?.type) ? onScroll.value : undefined);
      },
    };
  },
});

export const bad = [
  "import { ScrollView } from 'react-native';\nexport function Feed() {\n  const [offset, setOffset] = useState(0);\n  return <ScrollView onScroll={(e) => setOffset(e.nativeEvent.contentOffset.y)} scrollEventThrottle={16} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function Header() {\n  const [y, setY] = React.useState(0);\n  const onScroll = useAnimatedScrollHandler({\n    onScroll: (e) => {\n      runOnJS(setY)(e.contentOffset.y);\n    },\n  });\n  return <Animated.ScrollView onScroll={onScroll} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function List({ height }: { height: number }) {\n  const [progress, setProgress] = useState(0);\n  const handleScroll = useCallback((e) => {\n    setProgress(e.nativeEvent.contentOffset.y / height);\n  }, [height]);\n  return <FlatList onScroll={handleScroll} data={[]} renderItem={() => null} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function Pager() {\n  const [x, setX] = useState(0);\n  const handler = useAnimatedScrollHandler((e) => {\n    scheduleOnRN(setX, e.contentOffset.x);\n  });\n  return <Animated.FlatList onScroll={handler} />;\n}",
  // An updater is judged by what it returns.
  "import { ScrollView } from 'react-native';\nexport function Feed() {\n  const [y, setY] = useState(0);\n  return <ScrollView onScroll={(e) => setY(() => e.nativeEvent.contentOffset.y)} />;\n}",
  // A component of the app's own that forwards the scroll event.
  "import { View } from 'react-native';\nexport function Feed() {\n  const [y, setY] = useState(0);\n  return <Timeline onScroll={(e) => setY(e.nativeEvent.contentOffset.y)} />;\n}",
];

export const good = [
  // Set only when the threshold is crossed.
  "import { ScrollView } from 'react-native';\nexport function Header() {\n  const [shown, setShown] = useState(false);\n  const onScroll = useAnimatedScrollHandler({\n    onScroll: (e) => {\n      const next = e.contentOffset.y > 40;\n      if (next !== shown) runOnJS(setShown)(next);\n    },\n  });\n  return <Animated.ScrollView onScroll={onScroll} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function Sheet() {\n  const [read, setRead] = useState(false);\n  return <ScrollView onScroll={(e) => {\n    if (read) return;\n    setRead(true);\n  }} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function Feed() {\n  const offset = useRef(0);\n  return <ScrollView onScroll={(e) => { offset.current = e.nativeEvent.contentOffset.y; }} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function Header() {\n  const y = useSharedValue(0);\n  const onScroll = useAnimatedScrollHandler({ onScroll: (e) => { y.value = e.contentOffset.y; } });\n  return <Animated.ScrollView onScroll={onScroll} />;\n}",
  // Set once the scroll has stopped.
  "import { ScrollView } from 'react-native';\nexport function Feed() {\n  const [moving, setMoving] = useState(false);\n  const timer = useRef(0);\n  return <ScrollView onScroll={() => {\n    clearTimeout(timer.current);\n    timer.current = setTimeout(() => setMoving(false), 200);\n  }} />;\n}",
  // A boolean or an index set on every event: while it stays the same, React skips the render.
  "import { ScrollView } from 'react-native';\nexport function Drawer() {\n  const [compact, setCompact] = useState(false);\n  return <ScrollView onScroll={(e) => setCompact(e.nativeEvent.contentOffset.y > 80)} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function Pager() {\n  const [page, setPage] = useState(0);\n  const handler = useAnimatedScrollHandler((e) => {\n    scheduleOnRN(setPage, Math.round(e.contentOffset.x / 320));\n  });\n  return <Animated.FlatList onScroll={handler} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function Top() {\n  const [shown, setShown] = useState(false);\n  return <ScrollView onScroll={(e) => setShown(Boolean(e.nativeEvent.contentOffset.y))} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function Top() {\n  const [moved, setMoved] = useState(false);\n  return <ScrollView onScroll={(e) => setMoved(!!e.nativeEvent.contentOffset.y)} />;\n}",
  "import { ScrollView } from 'react-native';\nexport function Days({ width }: { width: number }) {\n  const [near, setNear] = useState(0);\n  return <ScrollView horizontal onScroll={(e) => setNear((now) => Math.round(e.nativeEvent.contentOffset.x / width))} />;\n}",
  // An updater that hands back the state it was given while the page is the same.
  "import { ScrollView } from 'react-native';\nexport function Days({ width }: { width: number }) {\n  const [near, setNear] = useState(0);\n  const moved = (event) => {\n    const at = Math.round(event.nativeEvent.contentOffset.x / width);\n    setNear((current) => (current === at ? current : at));\n  };\n  return <ScrollView horizontal onScroll={moved} />;\n}",
  // On the web a scroll handler is not this pack's.
  "export function Feed() {\n  const [top, setTop] = useState(0);\n  return <div onScroll={(e) => setTop(e.currentTarget.scrollTop)} />;\n}",
  // Another component's onScroll that hands over no scroll event.
  "import { View } from 'react-native';\nexport function Gallery() {\n  const [i, setI] = useState(0);\n  return <Carousel onScroll={(index: number) => setI(index)} />;\n}",
  // A reducer decides what changes: dispatch is not a state setter here.
  "import { ScrollView } from 'react-native';\nexport function Feed() {\n  const [state, dispatch] = useReducer(reduce, { y: 0 });\n  return <ScrollView onScroll={(e) => dispatch({ type: 'scroll', y: e.nativeEvent.contentOffset.y })} />;\n}",
  // A callback the parent passed in is not this component's state.
  "import { ScrollView } from 'react-native';\nexport function Feed({ setOffset }: { setOffset: (y: number) => void }) {\n  return <ScrollView onScroll={(e) => setOffset(e.nativeEvent.contentOffset.y)} />;\n}",
];
