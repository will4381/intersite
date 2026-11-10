// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, receiverName, unwrap, walk } from "../shared.mjs";

// A password, by name: `password`, `newPassword`, `user.passwd`, `pwd`; not `passwordResetToken`.
const PASSWORD = /pass(word|wd|code)$|^pwd$/i;
// One-shot hash functions: js-md5, js-sha256, crypto-js (`CryptoJS.SHA256`), hash-wasm.
const HASH_FN = /^(md5|sha1|sha224|sha256|sha384|sha512|MD5|SHA1|SHA224|SHA256|SHA384|SHA512)$/;

/** Whether a password is anywhere in `node`: itself, in a concatenation with a salt, in a template. @param {any} node */
function hasPassword(node) {
  let found = false;
  walk(node, (n) => {
    if (n.type.endsWith("FunctionExpression")) return false;
    if (n.type === "Identifier" && PASSWORD.test(n.name)) found = true;
  });
  return found;
}

/** `createHash('sha256').update(x)`: the hash object `update` is called on. @param {any} callee */
const onCreateHash = (callee) => calleeName(unwrap(callee.object)) === "createHash";

export const id = "no-fast-password-hash";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      fast: "A plain hash (MD5, SHA-1, even salted SHA-256) of a password can be brute-forced at billions of guesses a second once the table leaks. Hash passwords with a slow, salted password hash (argon2.hash, bcrypt.hash, or crypto.scrypt with a random salt) and check them with its verify function.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node);
        const [first, second] = /** @type {any[]} */ (node.arguments);
        const member = node.callee.type === "MemberExpression";
        const hashed =
          (member && name === "update" && onCreateHash(node.callee) && first) ||
          (member && name === "digest" && receiverName(node) === "subtle" && second) ||
          (HASH_FN.test(name) && (!member || /^(CryptoJS|crypto_js|hash)$/i.test(receiverName(node))) && first);
        if (hashed && hasPassword(hashed)) context.report({ node, messageId: "fast" });
      },
    };
  },
});

export const bad = [
  "const hash = createHash('sha256').update(password).digest('hex');",
  "const hash = crypto.createHash('md5').update(req.body.password).digest('hex');",
  "const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));",
  "const stored = createHash('sha1').update(user.passwd).digest('base64');",
  "const hash = createHash('sha256').update(password + salt).digest('hex');",
  "const hash = createHash('md5').update(`${salt}${password}`).digest('hex');",
  "const digest = sha256(password);",
  "const h = CryptoJS.SHA256(password).toString();",
];

export const good = [
  "const hash = await argon2.hash(password);",
  "const hash = createHash('sha256').update(rawToken).digest('hex');",
  "const key = scryptSync(password, salt, 64);",
  "const etag = createHash('md5').update(body).digest('hex');",
  "const stored = createHash('sha256').update(passwordResetToken).digest('hex');",
  "const h = createHash('sha256').update(fileBuffer).digest('hex');",
  "const id = sha256(user.email);",
];
