// @ts-check
import { defineRule } from "@oxlint/plugins";

export const id = "no-lowercase-type-name";
export const pack = "naming";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      found: "{{name}} is a type named like a value. Types, interfaces, enums and classes are PascalCase in TypeScript, so a lowercase or snake_case one reads as a variable at every use. Rename it {{fixed}}.",
    },
  },
  createOnce(context) {
    return {
      // Generated files (declaration files, OpenAPI schemas, database types, worker bindings) keep their generator's names.
      before: () => !/\.d\.[cm]?ts$|(?:^|\/)generated\/|\.gen(?:erated)?\.[cm]?[jt]sx?$/.test(context.filename),
      "TSTypeAliasDeclaration, TSInterfaceDeclaration, TSEnumDeclaration, ClassDeclaration"(node) {
        const name = node.id?.name;
        if (!name || !/^[a-z]|[a-z0-9]_[A-Za-z]/.test(name)) return;
        const fixed = name.split(/_+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
        context.report({ node: node.id, messageId: "found", data: { name, fixed } });
      },
    };
  },
});

export const bad = ["export type userProfile = { id: string };", "export interface api_response { ok: boolean }", "export class cartStore {}"];

export const good = ["export type UserProfile = { id: string };", "export interface ApiResponse { ok: boolean }", "export enum HttpStatus { Ok = 200 }"];
