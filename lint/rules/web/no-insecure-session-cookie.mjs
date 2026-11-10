// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, unwrap } from "../shared.mjs";
import { pieces } from "./no-interpolated-sql.mjs";

// A cookie that carries a session or credential, by its name; CSRF tokens are meant to be read by the page.
const SESSION = /(^|[-_.])(session|sess|sid|token|jwt|auth|access|refresh)([-_.]|$)|(session|token|auth)$/i;
const CSRF = /csrf|xsrf/i;

/** `cookies()`, `(await cookies())`, `res.cookies`, `cookieStore`: a cookie jar whose `.set` sets a cookie. @param {any} node */
function isJar(node) {
  node = unwrap(node);
  return calleeName(node) === "cookies" || (node?.type === "MemberExpression" && node.property.name === "cookies") || (node?.type === "Identifier" && node.name === "cookieStore");
}

/**
 * The name, value and options of a cookie this call sets: Express `res.cookie(name, value, opts)`, Fastify
 * `reply.setCookie(...)`, Hono and h3 `setCookie(c, name, value, opts)`, Next `cookies().set(name, value, opts)` or
 * `.set({ name, value, ...opts })`.
 * @param {any} node
 * @returns {{ name: any, value: any, options: any } | undefined}
 */
function cookieSet(node) {
  const method = calleeName(node);
  const member = node.callee.type === "MemberExpression";
  const args = /** @type {any[]} */ (node.arguments);
  let at = -1;
  if (member && (method === "cookie" || method === "setCookie")) at = 0;
  else if (!member && method === "setCookie") at = 1;
  else if (member && method === "set" && isJar(node.callee.object)) {
    const object = args[0]?.type === "ObjectExpression" ? args[0] : undefined;
    if (!object) at = 0;
    else {
      const prop = (/** @type {string} */ k) => object.properties.find((/** @type {any} */ p) => p.key?.name === k)?.value;
      return { name: prop("name"), value: prop("value"), options: object };
    }
  }
  return at < 0 ? undefined : { name: args[at], value: args[at + 1], options: args[at + 2] };
}

/** Options that leave the cookie readable by scripts: none, or an object without httpOnly (or with httpOnly: false). @param {any} options */
function readable(options) {
  if (!options) return true;
  if (options.type !== "ObjectExpression") return false; // shared options (`sessionCookieOptions`) are checked where they are written
  if (options.properties.some((/** @type {any} */ p) => p.type === "SpreadElement")) return false;
  const httpOnly = options.properties.find((/** @type {any} */ p) => p.key?.name === "httpOnly");
  return !httpOnly || httpOnly.value.value === false;
}

/** `Set-Cookie: session=...; Path=/` written by hand without HttpOnly. @param {any} node @param {any} sourceCode */
function rawSessionHeader(node, sourceCode) {
  const [name, value] = node.arguments;
  if (!/^(setHeader|append|set|header)$/.test(calleeName(node)) || !/^set-cookie$/i.test(name?.value ?? "")) return false;
  const values = unwrap(value)?.type === "ArrayExpression" ? unwrap(value).elements : [value];
  return values.some((/** @type {any} */ v) => {
    const text = (pieces(v, sourceCode) ?? []).map((/** @type {any} */ p) => ("text" in p ? p.text : "x")).join("");
    const cookie = /^\s*([^=;\s]+)=([^;]*)/.exec(text);
    return cookie && SESSION.test(cookie[1]) && !CSRF.test(cookie[1]) && cookie[2] !== "" && !/httponly/i.test(text);
  });
}

export const id = "no-insecure-session-cookie";
export const pack = "security";
// ponytail: `document.cookie = 'token=...'` (which can never be httpOnly) and shared option objects defined elsewhere are not checked.

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      cookie: 'A session or token cookie without httpOnly can be read by any script on the page, so one XSS bug hands over the session. Set { httpOnly: true, secure: true, sameSite: "lax" } (secure may follow NODE_ENV for local http); in a raw Set-Cookie header, add "; HttpOnly; Secure; SameSite=Lax".',
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const set = cookieSet(node);
        if (set) {
          const name = set.name?.value;
          if (typeof name !== "string" || !SESSION.test(name) || CSRF.test(name) || set.value?.value === "" || !readable(set.options)) return;
          return context.report({ node, messageId: "cookie" });
        }
        if (rawSessionHeader(node, context.sourceCode)) context.report({ node, messageId: "cookie" });
      },
    };
  },
});

export const bad = [
  "res.cookie('session', token);",
  "cookies().set('auth-token', jwt, { secure: true });",
  "setCookie(c, 'refresh_token', token, { path: '/' });",
  "res.cookie('sid', id, { httpOnly: false, secure: true });",
  "(await cookies()).set('accessToken', token, { maxAge: 3600 });",
  "cookies().set({ name: 'session', value: token, secure: true });",
  "reply.setCookie('token', jwt, { path: '/' });",
  "res.setHeader('Set-Cookie', `session=${token}; Path=/; Secure`);",
];

export const good = [
  "res.cookie('session', token, { httpOnly: true, secure: true, sameSite: 'lax' });",
  "cookies().set('theme', 'dark');",
  "res.cookie('session', token, sessionCookieOptions);",
  "setCookie(c, 'refresh_token', token, { ...COOKIE_DEFAULTS, maxAge: 3600 });",
  "res.cookie('tokenizer_hint', 'on');",
  "res.cookie('XSRF-TOKEN', req.csrfToken(), { secure: true });",
  "map.set('session', value);",
  "res.cookie('session', '', { maxAge: 0 });",
  "cookies().set({ name: 'session', value: token, httpOnly: true });",
  "res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`);",
  "res.setHeader('Set-Cookie', 'session=; Max-Age=0; Path=/');",
];
