// @ts-check
import { relative } from "node:path";

import { defineRule } from "@oxlint/plugins";

import { calleeName, resolveVariable } from "../shared.mjs";

// Decoders that never check a signature: jsonwebtoken's decode, jwt-decode, jose's decodeJwt.
const DECODER = /^(jsonwebtoken|jwt-decode|jose)$/;
// A file that also verifies is decoding to pick the key (`decode(token, { complete: true }).header.kid`).
const VERIFY = /^(jwtVerify|verifyJwt|verifyToken|verifyIdToken|verifyAccessToken)$/;
// Server code, where a decoded claim decides who the caller is. In the browser, reading `exp` from your own token is fine.
const SERVER_PATH = /(^|\/)(api|server|routes?|middlewares?|handlers?|controllers?|functions|workers?)\/|(^|\/)(middleware|proxy|route|server)\.[cm]?[jt]s$/;

/** Whether `node` was imported from (or required as) a token decoder. @param {any} node @param {any} sourceCode */
function fromDecoder(node, sourceCode) {
  if (node?.type !== "Identifier") return false;
  const def = resolveVariable(node, sourceCode)?.defs[0];
  if (def?.type === "ImportBinding") return DECODER.test(def.parent?.source?.value ?? "");
  const init = def?.node?.init;
  return /^(jwt|jsonwebtoken)$/.test(node.name) || (init?.type === "CallExpression" && init.callee.name === "require" && DECODER.test(init.arguments[0]?.value ?? ""));
}

/** Inside a function taking a request: `(req, res)`, `(request)`, `(c)`, `({ request })`, `(event)`. @param {any} node */
function inHandler(node) {
  for (let n = node.parent; n; n = n.parent) {
    const first = n.params?.[0];
    if (first?.type === "Identifier" && /^(req|request|ctx|c|event)$/.test(first.name)) return true;
    if (first?.type === "ObjectPattern" && first.properties.some((/** @type {any} */ p) => p.key?.name === "request")) return true;
  }
  return false;
}

export const id = "no-jwt-decode-without-verify";
export const pack = "security";
// ponytail: any verify call in the file excuses every decode in it, and jwtDecode in a server file outside SERVER_PATH or a request handler is not reported.

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      decode: "This reads a token without checking its signature, so anyone can write their own claims (sub, role, exp) and be trusted. Verify it first: jwt.verify(token, key), or jose's jwtVerify(token, key), and use the claims that returns.",
    },
  },
  createOnce(context) {
    /** @type {any[]} */
    let decodes;
    let verified = false;
    let server = false;
    return {
      before() {
        decodes = [];
        verified = false;
        server = SERVER_PATH.test(relative(context.cwd, context.filename));
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        const name = calleeName(node);
        if (VERIFY.test(name) || (name === "verify" && fromDecoder(callee.object, context.sourceCode))) verified = true;
        // jwt.decode(token), decode(token) from jsonwebtoken: a server library, so always server code.
        if (name === "decode" && fromDecoder(callee.type === "MemberExpression" ? callee.object : callee, context.sourceCode)) decodes.push(node);
        // jwtDecode / decodeJwt also run in browsers, so only in server code.
        if (/^(jwtDecode|decodeJwt)$/.test(name) && fromDecoder(callee.type === "MemberExpression" ? callee.object : callee, context.sourceCode) && (server || inHandler(node))) decodes.push(node);
      },
      "Program:exit"() {
        if (!verified) for (const node of decodes) context.report({ node, messageId: "decode" });
      },
    };
  },
});

export const bad = [
  "const user = jwt.decode(req.headers.authorization.split(' ')[1]);",
  "const { sub } = jwt.decode(token) as { sub: string };",
  "export function userId(token: string) { return (jsonwebtoken.decode(token) as JwtPayload).sub; }",
  "import { decode } from 'jsonwebtoken';\nconst user = decode(token);",
  "import jwt from 'jsonwebtoken';\nconst claims = jwt.decode(token) as Claims;\nconst ok = await cache.verify(claims.sub);",
  "import { jwtDecode } from 'jwt-decode';\nexport async function GET(req: Request) { const { sub } = jwtDecode(req.headers.get('authorization')!); return Response.json(await db.user(sub)); }",
  "import { decodeJwt } from 'jose';\napp.get('/me', (c) => c.json(decodeJwt(c.req.header('authorization')!)));",
];

export const good = [
  "const user = jwt.verify(token, process.env.JWT_SECRET);",
  "const { header } = jwt.decode(token, { complete: true }); const user = jwt.verify(token, keys[header.kid]);",
  "const { payload } = await jwtVerify(token, jwks);",
  "const html = he.decode(text);",
  "import { jwtDecode } from 'jwt-decode';\nexport function useUser() { const token = localStorage.getItem('t'); return token ? jwtDecode(token) : null; }",
  "import { decodeJwt } from 'jose';\nconst { exp } = decodeJwt(token);\nif (exp * 1000 < Date.now()) await refresh();",
];
