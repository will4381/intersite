// @ts-check
import { relative } from "node:path";

import { defineRule } from "@oxlint/plugins";

// What a guessable value must never be: `token`, `resetToken`, `otp`, `inviteCode`, `API_SECRET`, `generateApiKey`.
const SECRET = /^(token|secret|otp|nonce|password|passcode|salt|pin|code|apiKey|sessionId|licenseKey|inviteCode|resetCode|verificationCode|authCode|referralCode)$|(Token|Secret|Otp|OTP|Nonce|Password|Passcode|Salt|Pin|PIN|ApiKey|SessionId|LicenseKey|InviteCode|ResetCode|VerificationCode|AuthCode|ReferralCode)$|^[A-Z0-9_]*(TOKEN|SECRET|OTP|NONCE|PASSWORD|SALT|API_KEY)$|_(token|secret|otp|nonce|password|salt|pin|code)$/;
const FUNCTION = /^(generate|create|make|new|random|gen)\w*(Token|Secret|Otp|OTP|Nonce|Password|Passcode|Salt|Pin|PIN|Code|ApiKey|SessionId)$/;

/** @param {any} node */
const isMathRandom = (node) => node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object.name === "Math" && node.callee.property.name === "random";

/** @param {any} node */
function keyName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed) return node.property.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

/**
 * The name this value is stored under or returned as: the variable, assigned property or object key it flows into
 * before the nearest function boundary, else that function's own name.
 * @param {any} node
 */
function target(node) {
  for (let child = node, n = node.parent; n; child = n, n = n.parent) {
    if (n.type === "VariableDeclarator" && child === n.init) return keyName(n.id);
    if (n.type === "AssignmentExpression" && child === n.right) return keyName(n.left);
    if (n.type === "Property" && child === n.value) return keyName(n.key);
    if (n.type === "PropertyDefinition" && child === n.value) return keyName(n.key);
    if (n.type.endsWith("FunctionExpression") || n.type === "FunctionDeclaration") {
      const name = n.id?.name ?? (n.parent.type === "VariableDeclarator" ? keyName(n.parent.id) : n.parent.type === "MethodDefinition" || n.parent.type === "Property" ? keyName(n.parent.key) : undefined);
      return name && FUNCTION.test(name) ? name : undefined;
    }
  }
  return undefined;
}

export const id = "no-insecure-random";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      named: "Math.random() is predictable (its state can be recovered from a few outputs), so this {{ name }} can be guessed. Use crypto.randomUUID(), crypto.randomBytes(32).toString('base64url') or crypto.getRandomValues, and crypto.randomInt for numeric codes.",
      alphabet: "This builds a random string from an alphabet with Math.random(), the shape of a key, code or token generator, and Math.random() is predictable. Pick each character with crypto.randomInt(alphabet.length) (or crypto.getRandomValues), or use crypto.randomBytes(n).toString('base64url').",
    },
  },
  createOnce(context) {
    /** @type {Map<string, number>} lengths of string constants, by name */
    let strings;
    /** @type {{ node: any, alphabet: string }[]} */
    let picks;
    return {
      // Test data (a seeded gift-card code, a fake token) does not need to be unguessable.
      before() {
        if (/(^|\/)(__tests__|tests?|e2e|fixtures?)\/|\.(test|spec)\.[cm]?[jt]sx?$|[./-]fixtures?\.[cm]?[jt]sx?$/.test(relative(context.cwd, context.filename))) return false;
        strings = new Map();
        picks = [];
      },
      VariableDeclarator(node) {
        const init = /** @type {any} */ (node.init);
        if (node.id.type === "Identifier" && init?.type === "Literal" && typeof init.value === "string") strings.set(node.id.name, init.value.length);
      },
      CallExpression(node) {
        if (!isMathRandom(node)) return;
        const name = target(node);
        if (name && (SECRET.test(name) || FUNCTION.test(name))) return context.report({ node, messageId: "named", data: { name } });
        // `chars.charAt(Math.floor(Math.random() * chars.length))` or `ALPHABET[Math.floor(Math.random() * n)]`.
        for (let child = /** @type {any} */ (node), n = child.parent; n && !n.type.includes("Function"); child = n, n = n.parent) {
          const picked = n.type === "MemberExpression" && n.computed && child === n.property ? n.object
            : n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.name === "charAt" ? n.callee.object : undefined;
          if (picked?.type === "Identifier") { picks.push({ node, alphabet: picked.name }); break; }
        }
      },
      "Program:exit"() {
        // A long alphabet (letters and digits) means an identifier or secret; a short one is a color, a die or a sample.
        for (const { node, alphabet } of picks) if ((strings.get(alphabet) ?? 0) >= 32) context.report({ node, messageId: "alphabet" });
      },
    };
  },
});

export const bad = [
  "const token = Math.random().toString(36).slice(2);",
  "const otp = Math.floor(100000 + Math.random() * 900000);",
  "user.resetToken = Math.random().toString(36).substring(2, 15);",
  "function generateApiKey() { return 'sk_' + Math.random().toString(36).slice(2); }",
  "const invite = { inviteCode: Math.random().toString(36).slice(-8).toUpperCase() };",
  "const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';\nfunction segment() { let s = ''; for (let i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length)); return s; }",
];

export const good = [
  "const token = crypto.randomBytes(32).toString('base64url');",
  "const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;",
  "const delay = base * (0.75 + Math.random() * 0.5);",
  "const prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];",
  "const letters = '0123456789ABCDEF';\nfunction color() { let c = '#'; for (let i = 0; i < 6; i++) c += letters[Math.floor(Math.random() * 16)]; return c; }",
  "const code = crypto.randomInt(100000, 1000000);",
  "function tokenize(text) { return text.split(' ').sort(() => Math.random() - 0.5); }",
];
