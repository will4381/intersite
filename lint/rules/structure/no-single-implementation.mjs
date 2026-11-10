// @ts-check
import { defineRule } from "@oxlint/plugins";

/** `IUserService` for `UserService`, or `UserServiceImpl` / `DefaultUserService` for `UserService`: one class behind a mirror-named interface. @param {string} abstraction @param {string} impl */
const mirrored = (abstraction, impl) => abstraction === `I${impl}` || impl === `${abstraction}Impl` || impl === `Default${abstraction}` || abstraction === `${impl}Interface`;

/** Whether a declaration is exported, so code elsewhere may implement it. @param {any} node */
const isExported = (node) => node.parent?.type === "ExportNamedDeclaration" || node.parent?.type === "ExportDefaultDeclaration";

export const id = "no-single-implementation";
export const pack = "design";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      single: "{{name}} has exactly one implementation, {{impl}}, and nothing outside this file can add another, so the abstraction only adds a layer to read through. Use {{impl}} directly; extract the {{kind}} when a second implementation actually exists.",
    },
  },
  createOnce(context) {
    /** @type {Map<string, { node: any, kind: string }>} interfaces and abstract classes this file declares and keeps private */
    let abstractions = new Map();
    /** @type {Map<string, string[]>} name -> the classes implementing or extending it */
    let implementations = new Map();
    /** @type {Set<string>} names used anywhere other than an implements or extends clause */
    let otherUses = new Set();

    /** @param {string} name @param {string} impl */
    const implement = (name, impl) => implementations.set(name, [...(implementations.get(name) ?? []), impl]);

    return {
      before() {
        abstractions = new Map();
        implementations = new Map();
        otherUses = new Set();
        // Most files declare no interface or abstract class; skip walking their type references.
        return /\b(?:interface|abstract|implements)\b/.test(context.sourceCode.text);
      },
      TSInterfaceDeclaration(node) {
        if (!node.declare) abstractions.set(node.id.name, { node, kind: "interface" });
      },
      // `type Repo = { find(): User }` that a class implements is an interface by another name.
      TSTypeAliasDeclaration(node) {
        if (!node.declare && node.typeAnnotation.type === "TSTypeLiteral") abstractions.set(node.id.name, { node, kind: "type" });
      },
      "ClassDeclaration[abstract=true]"(node) {
        if (node.id && !node.declare) abstractions.set(node.id.name, { node, kind: "abstract class" });
      },
      "ClassDeclaration, ClassExpression"(node) {
        const name = node.id?.name ?? "an anonymous class";
        for (const clause of node.implements ?? []) if (clause.expression.type === "Identifier") implement(clause.expression.name, name);
        if (node.superClass?.type === "Identifier") implement(node.superClass.name, name);
      },
      // Any other reference (a parameter type, `extends` on another interface, a value use) means it is more than a layer.
      TSTypeReference(node) {
        if (node.typeName.type === "Identifier") otherUses.add(node.typeName.name);
      },
      TSInterfaceHeritage(node) {
        if (node.expression.type === "Identifier") otherUses.add(node.expression.name);
      },
      TSTypeQuery(node) {
        if (node.exprName.type === "Identifier") otherUses.add(node.exprName.name);
      },
      "Program:exit"() {
        for (const [name, { node, kind }] of abstractions) {
          const impls = implementations.get(name) ?? [];
          if (impls.length !== 1) continue;
          // An exported abstraction may have implementations elsewhere, unless its name only mirrors its one class.
          if (!mirrored(name, impls[0]) && (isExported(node) || otherUses.has(name))) continue;
          context.report({ node: node.id, messageId: "single", data: { name, impl: impls[0], kind } });
        }
      },
    };
  },
});

export const bad = [
  "interface PaymentGateway { charge(cents: number): Promise<void>; }\nexport class StripeGateway implements PaymentGateway { async charge(cents: number) { await stripe.charge(cents); } }",
  "abstract class BaseRepository { abstract find(id: string): unknown; }\nexport class UserRepository extends BaseRepository { find(id: string) { return db.users.get(id); } }",
  "export interface IUserService { find(id: string): unknown; }\nexport class UserService implements IUserService { find(id: string) { return db.get(id); } }",
  "export abstract class Notifier { abstract send(text: string): void; }\nexport class NotifierImpl extends Notifier { send(text: string) { console.info(text); } }",
  "interface Logger { log(message: string): void; }\nclass ConsoleLogger implements Logger { log(message: string) { console.info(message); } }\nexport const logger = new ConsoleLogger();",
  "type Repo = { find(id: string): unknown };\nclass PgRepo implements Repo { find(id: string) { return db.get(id); } }\nexport const repo = new PgRepo();",
];

export const good = [
  "export interface ModelProvider { reply(text: string): Promise<string>; }\nexport class OpenAiProvider implements ModelProvider { async reply(text: string) { return text; } }",
  "export interface PaymentGateway { charge(cents: number): Promise<void>; }\nexport class StripeGateway implements PaymentGateway { async charge(cents: number) { await stripe.charge(cents); } }",
  "interface Store { get(key: string): string | undefined; }\nclass MemoryStore implements Store { get(key: string) { return undefined; } }\nclass KvStore implements Store { get(key: string) { return kv.get(key); } }\nexport const stores = [new MemoryStore(), new KvStore()];",
  "interface Clock { now(): number; }\nclass SystemClock implements Clock { now() { return Date.now(); } }\nexport function schedule(clock: Clock = new SystemClock()) { return clock.now() + 1000; }",
  "interface Props { name: string; }\nexport function greet(props: Props) { return props.name; }",
  "type Point = { x: number };\nexport const origin: Point = { x: 0 };",
];
