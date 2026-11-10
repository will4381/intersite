// @ts-check
import { defineRule } from "@oxlint/plugins";

export const id = "no-jwt-decode-without-verify";
export const pack = "security";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      decode: "jwt.decode reads a token without checking its signature, so anyone can write their own claims. Use jwt.verify(token, key) (or jose's jwtVerify) before trusting anything in it.",
    },
  },
  createOnce(context) {
    /** @type {any[]} */
    let decodes;
    let verified = false;
    return {
      before() {
        decodes = [];
        verified = false;
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee);
        if (callee.type !== "MemberExpression") return;
        const method = callee.property.name;
        // A file that also verifies is decoding to pick the key (`decode(token, { complete: true }).header.kid`).
        if (method === "verify" || method === "jwtVerify") verified = true;
        else if (method === "decode" && /^(jwt|jsonwebtoken)$/.test(callee.object.name ?? "")) decodes.push(node);
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
];

export const good = [
  "const user = jwt.verify(token, process.env.JWT_SECRET);",
  "const { header } = jwt.decode(token, { complete: true }); const user = jwt.verify(token, keys[header.kid]);",
  "const { payload } = await jwtVerify(token, jwks);",
  "const html = he.decode(text);",
];
