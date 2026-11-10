// @ts-check
import { defineRule } from "@oxlint/plugins";

/** @param {any} property */
const key = (property) => String(property.key?.name ?? property.key?.value ?? "").toLowerCase();

export const id = "no-credentialed-wildcard-cors";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      open: "This lets every website make requests with your users' cookies and read the answers (origin * or true, or the caller's own Origin echoed back). List the allowed origins explicitly, as in cors({ origin: ['https://app.example.com'], credentials: true }), or drop credentials for a public API.",
    },
  },
  createOnce(context) {
    return {
      ObjectExpression(node) {
        /** @type {Map<string, any>} */
        const props = new Map();
        for (const p of /** @type {any[]} */ (node.properties)) if (p.type === "Property") props.set(key(p), p.value);
        // cors({ origin: true, credentials: true }) and Fastify's @fastify/cors
        const origin = props.get("origin");
        if (props.get("credentials")?.value === true && (origin?.value === "*" || origin?.value === true)) return context.report({ node, messageId: "open" });
        // Hand-written headers that echo whatever Origin the request sent.
        const allow = props.get("access-control-allow-origin");
        if (props.get("access-control-allow-credentials")?.value === "true" && allow && allow.type !== "Literal" && allow.type !== "TemplateLiteral") context.report({ node, messageId: "open" });
      },
    };
  },
});

export const bad = [
  "app.use(cors({ origin: true, credentials: true }));",
  "app.use(cors({ origin: '*', credentials: true }));",
  "await app.register(fastifyCors, { credentials: true, origin: true });",
  "return new Response(body, { headers: { 'Access-Control-Allow-Origin': request.headers.get('origin'), 'Access-Control-Allow-Credentials': 'true' } });",
];

export const good = [
  "app.use(cors({ origin: ['https://app.example.com'], credentials: true }));",
  "app.use(cors({ origin: '*' }));",
  "app.use(cors({ origin: allowedOrigin, credentials: true }));",
  "return new Response(body, { headers: { 'Access-Control-Allow-Origin': 'https://app.example.com', 'Access-Control-Allow-Credentials': 'true' } });",
];
