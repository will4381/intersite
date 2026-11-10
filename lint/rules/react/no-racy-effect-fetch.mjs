// @ts-check
import { defineRule } from "@oxlint/plugins";

import { enclosingFunction, walk } from "../shared.mjs";
import { EFFECT, isHookCall, stateSetters } from "./hooks.mjs";

/** `fetch(…)`, `axios(…)` or `axios.get(…)`. A project's own client (`api.get`) is too wide to guess. @param {any} node */
const isRequest = (node) =>
  node.type === "CallExpression" &&
  (node.callee.name === "fetch" || node.callee.name === "axios" || (node.callee.type === "MemberExpression" && node.callee.object.name === "axios"));

/** Any sign the effect already guards against a stale response: an abort signal, an ignore/cancelled flag, a ref check. */
const guarded = /AbortController|signal|cancel|ignore|stale|active|mounted|alive|unmount|current|latest/i;

export const id = "no-racy-effect-fetch";
export const pack = "react";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      race: "This effect requests data and stores the response in state with no cleanup, so when its dependencies ({{deps}}) change quickly an older response can arrive after a newer one and overwrite it. Create an AbortController, pass its signal to the request and return () => controller.abort(); or load the data with the project's query library (TanStack Query, SWR) instead of an effect.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const [callback, deps] = node.arguments;
        // With no dependencies the effect runs once, so no newer request can be overtaken.
        if (!isHookCall(node, EFFECT) || !callback?.type.endsWith("FunctionExpression") || deps?.type !== "ArrayExpression" || !deps.elements.length) return;
        if (callback.body.type === "BlockStatement" && callback.body.body.some((/** @type {any} */ s) => s.type === "ReturnStatement" && s.argument)) return;
        const component = enclosingFunction(node);
        if (!component) return;
        const setters = stateSetters(component);
        let request = Infinity;
        let setAfter = false;
        walk(callback.body, (n) => {
          if (isRequest(n)) request = Math.min(request, n.start);
          else if (n.type === "Identifier" && setters.has(n.name) && n.start > request) setAfter = true;
        });
        if (!setAfter || guarded.test(context.sourceCode.getText(callback))) return;
        context.report({ node, messageId: "race", data: { deps: deps.elements.map((/** @type {any} */ d) => context.sourceCode.getText(d)).join(", ") } });
      },
    };
  },
});

export const bad = [
  "export function User({ id }) {\n  const [user, setUser] = useState(null);\n  useEffect(() => {\n    fetch(`/api/users/${id}`).then((r) => r.json()).then(setUser);\n  }, [id]);\n  return <p>{user?.name}</p>;\n}",
  "export function Search({ query }) {\n  const [results, setResults] = useState([]);\n  useEffect(() => {\n    const load = async () => {\n      const res = await fetch('/api/search?q=' + query);\n      setResults(await res.json());\n    };\n    load();\n  }, [query]);\n  return <List items={results} />;\n}",
  "export function Orders({ customerId }) {\n  const [orders, setOrders] = React.useState([]);\n  React.useEffect(() => {\n    axios.get(`/orders/${customerId}`).then((res) => setOrders(res.data));\n  }, [customerId]);\n  return <List items={orders} />;\n}",
];

export const good = [
  "export function User({ id }) {\n  const [user, setUser] = useState(null);\n  useEffect(() => {\n    const controller = new AbortController();\n    fetch(`/api/users/${id}`, { signal: controller.signal }).then((r) => r.json()).then(setUser);\n    return () => controller.abort();\n  }, [id]);\n  return <p>{user?.name}</p>;\n}",
  "export function Search({ query }) {\n  const [results, setResults] = useState([]);\n  useEffect(() => {\n    let ignore = false;\n    fetch('/api/search?q=' + query).then((r) => r.json()).then((data) => { if (!ignore) setResults(data); });\n    return () => { ignore = true; };\n  }, [query]);\n  return <List items={results} />;\n}",
  // Runs once: nothing newer can overtake it.
  "export function Config() {\n  const [config, setConfig] = useState(null);\n  useEffect(() => { fetch('/config.json').then((r) => r.json()).then(setConfig); }, []);\n  return <pre>{JSON.stringify(config)}</pre>;\n}",
  // Fire and forget: the response is not stored.
  "export function Track({ page }) {\n  useEffect(() => { fetch('/api/views', { method: 'POST', body: page }); }, [page]);\n  return null;\n}",
  // The loading flag is set before the request, not from its response.
  "export function Ping({ url }) {\n  const [busy, setBusy] = useState(false);\n  useEffect(() => { setBusy(true); fetch(url, { method: 'HEAD' }); }, [url]);\n  return <p>{busy ? '…' : ''}</p>;\n}",
];
