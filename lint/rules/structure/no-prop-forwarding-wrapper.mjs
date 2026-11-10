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

const wrappers = /^(?:memo|forwardRef)$/;

export const id = "no-prop-forwarding-wrapper";
export const pack = "design";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      wrapper: "This component renders <{{child}}> with exactly the props it was given and nothing else, so it is another name for {{child}}. Use {{child}} directly, or re-export it under the new name (as memo({{child}}) if it must be memoised).",
    },
  },
  createOnce(context) {
    /** @param {any} node */
    function check(node) {
      // Components only: a declared function with a capitalized name, not a callback such as items.map((p) => <Row {...p} />).
      // memo(...) and forwardRef(...) around it keep the name of the variable they are assigned to.
      let holder = node.parent;
      while (holder.type === "CallExpression" && wrappers.test(holder.callee.name ?? holder.callee.property?.name ?? "")) holder = holder.parent;
      const name = node.type === "FunctionDeclaration" ? node.id?.name : holder.type === "VariableDeclarator" ? holder.id.name : undefined;
      // A generic component (`<T,>(props: ListProps<T>)`) narrows a loose child's types, which is work of its own.
      if (!/^[A-Z]/.test(name ?? "") || node.typeParameters) return;
      const [props, ref, ...rest] = node.params;
      if (rest.length || props?.type !== "Identifier" || (ref && ref.type !== "Identifier")) return;
      const element = onlyElement(node.body);
      if (!element || element.children.length) return;
      const [spread, ...others] = element.openingElement.attributes;
      if (spread?.type !== "JSXSpreadAttribute" || spread.argument.type !== "Identifier" || spread.argument.name !== props.name) return;
      // forwardRef((props, ref) => <Input {...props} ref={ref} />) forwards the ref as well, and adds nothing either.
      const forwardsRef = (/** @type {any} */ a) => ref && a.type === "JSXAttribute" && a.name.name === "ref" && a.value?.expression?.name === ref.name;
      if (others.length !== (ref ? 1 : 0) || !others.every(forwardsRef)) return;
      context.report({ node, messageId: "wrapper", data: { child: context.sourceCode.getText(element.openingElement.name) } });
    }
    return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check };
  },
});

export const bad = [
  "export const PrimaryButton = (props: ButtonProps) => <Button {...props} />;",
  "export function Card(props: CardProps) {\n  return <BaseCard {...props} />;\n}",
  "export const Title = function Title(props) { return <Heading.H1 {...props}></Heading.H1>; };",
  "export const Input = forwardRef<HTMLInputElement, InputProps>((props, ref) => <BaseInput {...props} ref={ref} />);",
  "export const Card = memo((props: CardProps) => <BaseCard {...props} />);",
  "export const Card = React.memo(function Card(props: CardProps) { return <BaseCard {...props} />; });",
];

export const good = [
  "export const PrimaryButton = (props: ButtonProps) => <Button variant=\"primary\" {...props} />;",
  "export function Card({ title, ...rest }: CardProps) { return <BaseCard {...rest} />; }",
  "export const Row = (props: RowProps) => <Cell {...props}>{props.label}</Cell>;",
  "export const List = (props: ListProps) => <Virtual {...props} render={(item) => <Item {...item} />} />;",
  "export const routes = items.map((props) => <Route {...props} />);",
  "export const Input = forwardRef<HTMLInputElement, InputProps>((props, ref) => <BaseInput className=\"input\" {...props} ref={ref} />);",
  "export function List<T>(props: ListProps<T>) { return <Virtual {...props} />; }",
  "export const Field = (props: FieldProps, context: Context) => <Input {...props} />;",
];
