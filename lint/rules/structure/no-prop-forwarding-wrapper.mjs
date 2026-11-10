// @ts-check
import { defineRule } from "@oxlint/plugins";

/** The JSX element a component body only returns. @param {any} body */
function onlyElement(body) {
  let value = body;
  if (body.type === "BlockStatement") {
    if (body.body.length !== 1 || body.body[0].type !== "ReturnStatement") return undefined;
    value = body.body[0].argument;
  }
  return value?.type === "JSXElement" ? value : undefined;
}

export const id = "no-prop-forwarding-wrapper";
export const pack = "design";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      wrapper: "This component renders <{{child}}> with exactly the props it was given and nothing else, so it is another name for {{child}}. Use {{child}} directly, or re-export it under the new name.",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    function check(node) {
      // Components only: a declared function with a capitalized name, not a callback such as items.map((p) => <Row {...p} />).
      const name = node.type === "FunctionDeclaration" ? node.id?.name : node.parent.type === "VariableDeclarator" ? node.parent.id.name : undefined;
      if (!/^[A-Z]/.test(name ?? "")) return;
      const [props, ...rest] = node.params;
      if (rest.length || props?.type !== "Identifier") return;
      const element = onlyElement(node.body);
      if (!element || element.children.length) return;
      const attributes = element.openingElement.attributes;
      if (attributes.length !== 1 || attributes[0].type !== "JSXSpreadAttribute" || attributes[0].argument.type !== "Identifier" || attributes[0].argument.name !== props.name) return;
      context.report({ node, messageId: "wrapper", data: { child: context.sourceCode.getText(element.openingElement.name) } });
    }
    return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check };
  },
});

export const bad = [
  "export const PrimaryButton = (props: ButtonProps) => <Button {...props} />;",
  "export function Card(props: CardProps) {\n  return <BaseCard {...props} />;\n}",
  "export const Title = function Title(props) { return <Heading.H1 {...props}></Heading.H1>; };",
];

export const good = [
  "export const PrimaryButton = (props: ButtonProps) => <Button variant=\"primary\" {...props} />;",
  "export function Card({ title, ...rest }: CardProps) { return <BaseCard {...rest} />; }",
  "export const Row = (props: RowProps) => <Cell {...props}>{props.label}</Cell>;",
  "export const List = (props: ListProps) => <Virtual {...props} render={(item) => <Item {...item} />} />;",
  "export const routes = items.map((props) => <Route {...props} />);",
];
