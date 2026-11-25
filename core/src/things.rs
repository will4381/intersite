//! What one file declares and what its code knows of other declarations, for the `structure` gate. A thing is a
//! top-level declaration: a class (with its fields and methods), a function, a type, or a value. A use is a reference
//! from a thing's code (or from top-level code) to a thing of this file or to an imported name, resolved by scope, so
//! a local that shadows an import is not a use of it. A mutation is code that changes a field of a class instance
//! from outside the class: an assignment, `++`, `delete` or a mutating call (`push`, `set`…) on the field.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_ecmascript::BoundNames;
use oxc_semantic::{Scoping, SemanticBuilder};
use oxc_span::GetSpan;
use oxc_syntax::symbol::SymbolId;
use std::collections::HashMap;

use crate::text::Lines;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ThingKind {
    Class,
    Function,
    Type,
    Value,
}

#[derive(Default, Debug)]
pub struct Class {
    /// Instance fields: name, line, and whether code outside may reach it (not `private`, `protected` or `#`).
    pub fields: Vec<(String, u32, bool)>,
    /// A getter that hands out a field: getter name, field name.
    pub getters: HashMap<String, String>,
    /// Methods: name, line, whether `private`/`protected`/`#`, whether it works on the fields (uses `this.<field>`
    /// beyond handing one out or setting one).
    pub methods: Vec<(String, u32, bool, bool)>,
    /// A decorator on the class or a member: an ORM entity, a framework component or an observable store, whose
    /// fields the framework expects outside code to set.
    pub decorated: bool,
}

#[derive(Debug)]
pub struct Thing {
    pub name: String,
    pub kind: ThingKind,
    pub line: u32,
    pub class: Option<Class>,
    /// `const queue = new Queue()`: the class it is an instance of.
    pub instance_of: Option<Origin>,
    /// A function whose body only calls another and returns what it returns.
    pub forwards: bool,
    /// A React component: a capitalised function in a JSX file.
    pub component: bool,
}

/// Where a name used in this file comes from.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Origin {
    /// A thing of this file, by index.
    Local(usize),
    /// An import binding, by index.
    Import(usize),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Imported {
    Name(String),
    Namespace,
}

#[derive(Debug)]
pub struct Binding {
    pub spec: String,
    pub imported: Imported,
}

#[derive(Debug)]
pub enum Export {
    /// `export function a`, `export { a as b }`, `export default a`: the exported name and where it comes from.
    Local { exported: String, origin: Origin },
    /// `export { a as b } from "x"`; `export * as ns from "x"` takes the namespace.
    From { exported: String, spec: String, imported: Imported },
    /// `export * from "x"`.
    Star { spec: String },
}

#[derive(Debug)]
pub struct Use {
    /// The thing whose code holds it; None for top-level code.
    pub from: Option<usize>,
    pub to: Origin,
    /// For a namespace import, the member named: `ns.member`.
    pub member: Option<String>,
    pub line: u32,
    pub type_only: bool,
    /// Where the innermost function holding it starts (0 outside any): each closure is a caller of its own.
    pub scope: u32,
}

/// What an expression is known to hold.
#[derive(Clone, Debug)]
pub enum Typed {
    /// An instance of the class this origin names.
    Instance(Origin),
    /// Whatever the origin is: an instance, if it is a value made with `new`.
    Value(Origin),
}

#[derive(Debug)]
pub struct Mutation {
    pub from: Option<usize>,
    pub base: Typed,
    pub field: String,
    pub line: u32,
    /// The code that does it, shortened: `queue.items.push(…)`.
    pub code: String,
}

/// A method called on a known instance: `queue.next()`.
#[derive(Debug)]
pub struct Call {
    pub from: Option<usize>,
    pub base: Typed,
    pub method: String,
    pub line: u32,
    pub scope: u32,
}

#[derive(Default, Debug)]
pub struct FileModel {
    pub things: Vec<Thing>,
    pub bindings: Vec<Binding>,
    pub exports: Vec<Export>,
    pub uses: Vec<Use>,
    pub mutations: Vec<Mutation>,
    pub calls: Vec<Call>,
}

const MUTATORS: [&str; 14] =
    ["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "delete", "clear", "add", "append"];

fn type_name<'b>(t: &'b TSType<'b>) -> Option<&'b IdentifierReference<'b>> {
    match t {
        TSType::TSTypeReference(r) => match &r.type_name {
            TSTypeName::IdentifierReference(id) => Some(id),
            _ => None,
        },
        // `Queue | null`, `Queue | undefined`.
        TSType::TSUnionType(u) => {
            let mut named = u.types.iter().filter(|t| !matches!(t, TSType::TSNullKeyword(_) | TSType::TSUndefinedKeyword(_)));
            match (named.next(), named.next()) {
                (Some(only), None) => type_name(only),
                _ => None,
            }
        }
        TSType::TSParenthesizedType(p) => type_name(&p.type_annotation),
        _ => None,
    }
}

fn unwrap_expr<'b>(e: &'b Expression<'b>) -> &'b Expression<'b> {
    match e {
        Expression::ParenthesizedExpression(p) => unwrap_expr(&p.expression),
        Expression::TSNonNullExpression(n) => unwrap_expr(&n.expression),
        Expression::TSAsExpression(a) => unwrap_expr(&a.expression),
        Expression::TSSatisfiesExpression(s) => unwrap_expr(&s.expression),
        _ => e,
    }
}

fn is_jsx_file(path: &str) -> bool {
    path.ends_with(".tsx") || path.ends_with(".jsx")
}

fn returns_jsx(f: &FunctionBody) -> bool {
    struct Find(bool);
    impl<'a> Visit<'a> for Find {
        fn visit_jsx_element(&mut self, _: &JSXElement<'a>) {
            self.0 = true;
        }
        fn visit_jsx_fragment(&mut self, _: &JSXFragment<'a>) {
            self.0 = true;
        }
    }
    let mut find = Find(false);
    find.visit_function_body(f);
    find.0
}

/// A body that is one call, returned or not, passing its parameters on: `(a, b) => other(a, b)`.
fn forwards(body: &FunctionBody) -> bool {
    let call = match body.statements.as_slice() {
        [Statement::ReturnStatement(r)] => r.argument.as_ref(),
        [Statement::ExpressionStatement(e)] => Some(&e.expression),
        _ => None,
    };
    matches!(call.map(unwrap_expr), Some(Expression::CallExpression(_)) | Some(Expression::AwaitExpression(_)))
}

/// `this.items`, the field name.
fn this_field<'b>(e: &'b Expression<'b>) -> Option<&'b str> {
    match unwrap_expr(e) {
        Expression::StaticMemberExpression(m) if matches!(unwrap_expr(&m.object), Expression::ThisExpression(_)) => {
            Some(m.property.name.as_str())
        }
        _ => None,
    }
}

/// The class a class body declares, read before its methods are walked.
fn read_class(c: &oxc_ast::ast::Class, lines: &Lines) -> Class {
    let at = |offset: u32| lines.line(offset as usize);
    let mut class = Class { decorated: !c.decorators.is_empty(), ..Default::default() };
    let field = |name: &str, line: u32, public: bool, class: &mut Class| {
        if !class.fields.iter().any(|(n, _, _)| n == name) {
            class.fields.push((name.to_string(), line, public));
        }
    };
    for element in &c.body.body {
        match element {
            ClassElement::PropertyDefinition(p) if !p.r#static => {
                class.decorated |= !p.decorators.is_empty();
                // A property holding a function is a method written as an arrow.
                if matches!(
                    p.value.as_ref().map(unwrap_expr),
                    Some(Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_))
                ) {
                    continue;
                }
                let public = !matches!(p.key, PropertyKey::PrivateIdentifier(_))
                    && !matches!(p.accessibility, Some(TSAccessibility::Private | TSAccessibility::Protected));
                if let Some(name) = p.key.static_name() {
                    field(&name, at(p.span.start), public, &mut class);
                }
            }
            ClassElement::AccessorProperty(p) if !p.r#static => class.decorated |= !p.decorators.is_empty(),
            ClassElement::MethodDefinition(m) => {
                class.decorated |= !m.decorators.is_empty();
                if m.kind == MethodDefinitionKind::Constructor {
                    for p in &m.value.params.items {
                        class.decorated |= !p.decorators.is_empty();
                        if p.accessibility.is_some() || p.readonly {
                            if let BindingPattern::BindingIdentifier(id) = &p.pattern {
                                let public = !matches!(p.accessibility, Some(TSAccessibility::Private | TSAccessibility::Protected));
                                field(&id.name, at(p.span.start), public, &mut class);
                            }
                        }
                    }
                    // `this.x = …` in a JavaScript constructor declares x.
                    if let Some(body) = &m.value.body {
                        for s in &body.statements {
                            if let Statement::ExpressionStatement(e) = s {
                                if let Expression::AssignmentExpression(a) = &e.expression {
                                    if let Some(member) = a.left.as_member_expression() {
                                        if let (Expression::ThisExpression(_), Some(name)) =
                                            (&member.object(), member.static_property_name())
                                        {
                                            field(name, at(a.span.start), true, &mut class);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let fields: Vec<String> = class.fields.iter().map(|(n, _, _)| n.clone()).collect();
    for element in &c.body.body {
        let (name, private, function, kind) = match element {
            ClassElement::MethodDefinition(m) if !m.r#static && m.kind != MethodDefinitionKind::Constructor => {
                let private = matches!(m.key, PropertyKey::PrivateIdentifier(_))
                    || matches!(m.accessibility, Some(TSAccessibility::Private | TSAccessibility::Protected));
                (m.key.static_name(), private, Some(&*m.value), m.kind)
            }
            _ => continue,
        };
        let Some(name) = name else { continue };
        let Some(body) = function.and_then(|f| f.body.as_ref()) else { continue };
        if kind == MethodDefinitionKind::Get {
            if let [Statement::ReturnStatement(r)] = body.statements.as_slice() {
                if let Some(f) = r.argument.as_ref().and_then(this_field) {
                    class.getters.insert(name.to_string(), f.to_string());
                }
            }
            continue;
        }
        if kind == MethodDefinitionKind::Set {
            continue;
        }
        struct Uses<'f>(&'f [String], bool);
        impl<'a> Visit<'a> for Uses<'_> {
            fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
                if matches!(it.object, Expression::ThisExpression(_)) && self.0.iter().any(|f| f == it.property.name.as_str()) {
                    self.1 = true;
                }
                walk::walk_static_member_expression(self, it);
            }
        }
        let mut uses = Uses(&fields, false);
        uses.visit_function_body(body);
        let wrapper =
            matches!(body.statements.as_slice(), [Statement::ReturnStatement(r)] if r.argument.as_ref().and_then(this_field).is_some());
        let line = function.map_or(0, |f| at(f.span.start));
        class.methods.push((name.to_string(), line, private, uses.1 && !wrapper));
    }
    class
}

struct Walker<'s> {
    src: &'s str,
    lines: Lines,
    scoping: &'s Scoping,
    model: FileModel,
    /// Root-scope symbols: what each names.
    origins: HashMap<SymbolId, Origin>,
    /// Symbols of any scope known to hold an instance of a class.
    typed: HashMap<SymbolId, Origin>,
    /// The thing whose code is being walked.
    current: Option<usize>,
    /// Per class being walked, its properties known to hold an instance of a class.
    props: Vec<HashMap<String, Origin>>,
    /// Starts of the functions being walked, innermost last.
    scopes: Vec<u32>,
}

impl Walker<'_> {
    fn line(&self, offset: u32) -> u32 {
        self.lines.line(offset as usize)
    }

    fn scope(&self) -> u32 {
        self.scopes.last().copied().unwrap_or(0)
    }

    fn symbol_of(&self, id: &IdentifierReference) -> Option<SymbolId> {
        id.reference_id.get().and_then(|r| self.scoping.get_reference(r).symbol_id())
    }

    fn origin_of(&self, id: &IdentifierReference) -> Option<Origin> {
        self.symbol_of(id).and_then(|s| self.origins.get(&s).cloned())
    }

    /// A use of `member` of the namespace `id` names (`ns.member`); false when `id` is not a namespace.
    fn namespace_use(&mut self, id: &IdentifierReference, member: &str, type_only: bool) -> bool {
        let Some(origin) = self.origin_of(id).filter(|o| self.is_namespace(o)) else { return false };
        let line = self.line(id.span.start);
        self.model.uses.push(Use {
            from: self.current,
            to: origin,
            member: Some(member.to_string()),
            line,
            type_only,
            scope: self.scope(),
        });
        true
    }

    fn is_namespace(&self, origin: &Origin) -> bool {
        matches!(origin, Origin::Import(b) if self.model.bindings[*b].imported == Imported::Namespace)
    }

    /// What an expression holds, when it is known: a typed local, a property of `this` with a known class, or a
    /// root-scope value whose class is settled across files.
    fn typed(&self, e: &Expression) -> Option<Typed> {
        match unwrap_expr(e) {
            Expression::Identifier(id) => {
                let symbol = self.symbol_of(id)?;
                if let Some(o) = self.typed.get(&symbol) {
                    return Some(Typed::Instance(o.clone()));
                }
                self.origins.get(&symbol).filter(|o| !self.is_namespace(o)).map(|o| Typed::Value(o.clone()))
            }
            Expression::StaticMemberExpression(m) if matches!(unwrap_expr(&m.object), Expression::ThisExpression(_)) => {
                self.props.last()?.get(m.property.name.as_str()).map(|o| Typed::Instance(o.clone()))
            }
            _ => None,
        }
    }

    /// The field a member chain reaches on a known instance: `queue.items[0].x` is (queue, items).
    fn reached(&self, member: &MemberExpression) -> Option<(Typed, String)> {
        if let MemberExpression::StaticMemberExpression(m) = member {
            if let Some(t) = self.typed(&m.object) {
                return Some((t, m.property.name.to_string()));
            }
        }
        self.reached(unwrap_expr(member.object()).as_member_expression()?)
    }

    /// A write through `member`, when it reaches a field of a known instance; `span` is the code shown.
    fn mutation(&mut self, member: &MemberExpression, span: oxc_span::Span) {
        let Some((base, field)) = self.reached(member) else { return };
        let mut code: String = self.src[span.start as usize..span.end as usize].split_whitespace().collect::<Vec<_>>().join(" ");
        if code.chars().count() > 60 {
            code = code.chars().take(57).collect::<String>() + "…";
        }
        let line = self.line(span.start);
        self.model.mutations.push(Mutation { from: self.current, base, field, line, code });
    }

    fn class_of(&self, t: &TSTypeAnnotation) -> Option<Origin> {
        type_name(&t.type_annotation).and_then(|id| self.origin_of(id))
    }

    fn new_of(&self, e: &Expression) -> Option<Origin> {
        match unwrap_expr(e) {
            Expression::NewExpression(n) => match unwrap_expr(&n.callee) {
                Expression::Identifier(id) => self.origin_of(id),
                _ => None,
            },
            _ => None,
        }
    }
}

impl<'a> Visit<'a> for Walker<'_> {
    fn visit_function(&mut self, it: &Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        self.scopes.push(it.span.start);
        walk::walk_function(self, it, flags);
        self.scopes.pop();
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        self.scopes.push(it.span.start);
        walk::walk_arrow_function_expression(self, it);
        self.scopes.pop();
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        let Some(r) = it.reference_id.get() else { return };
        let reference = self.scoping.get_reference(r);
        let Some(origin) = reference.symbol_id().and_then(|s| self.origins.get(&s).cloned()) else { return };
        // A thing naming itself (recursion, a class using its own type) is not a use of another.
        if matches!(origin, Origin::Local(i) if Some(i) == self.current) {
            return;
        }
        let line = self.line(it.span.start);
        self.model.uses.push(Use {
            from: self.current,
            to: origin,
            member: None,
            line,
            type_only: reference.is_type() && !reference.is_value(),
            scope: self.scope(),
        });
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if let Expression::Identifier(id) = &it.object {
            if self.namespace_use(id, &it.property.name, false) {
                return;
            }
        }
        walk::walk_static_member_expression(self, it);
    }

    fn visit_ts_qualified_name(&mut self, it: &TSQualifiedName<'a>) {
        if let TSTypeName::IdentifierReference(id) = &it.left {
            if self.namespace_use(id, &it.right.name, true) {
                return;
            }
        }
        walk::walk_ts_qualified_name(self, it);
    }

    fn visit_jsx_member_expression(&mut self, it: &JSXMemberExpression<'a>) {
        if let JSXMemberExpressionObject::IdentifierReference(id) = &it.object {
            if self.namespace_use(id, &it.property.name, false) {
                return;
            }
        }
        walk::walk_jsx_member_expression(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(id) = &it.id {
            let class =
                it.type_annotation.as_ref().and_then(|t| self.class_of(t)).or_else(|| it.init.as_ref().and_then(|e| self.new_of(e)));
            if let (Some(symbol), Some(class)) = (id.symbol_id.get(), class) {
                self.typed.insert(symbol, class);
            }
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_formal_parameter(&mut self, it: &FormalParameter<'a>) {
        if let BindingPattern::BindingIdentifier(id) = &it.pattern {
            if let (Some(symbol), Some(class)) = (id.symbol_id.get(), it.type_annotation.as_ref().and_then(|t| self.class_of(t))) {
                self.typed.insert(symbol, class);
            }
        }
        walk::walk_formal_parameter(self, it);
    }

    fn visit_class(&mut self, it: &oxc_ast::ast::Class<'a>) {
        let mut props = HashMap::new();
        for element in &it.body.body {
            match element {
                ClassElement::PropertyDefinition(p) => {
                    let class =
                        p.type_annotation.as_ref().and_then(|t| self.class_of(t)).or_else(|| p.value.as_ref().and_then(|e| self.new_of(e)));
                    if let (Some(name), Some(class)) = (p.key.static_name(), class) {
                        props.insert(name.to_string(), class);
                    }
                }
                ClassElement::MethodDefinition(m) if m.kind == MethodDefinitionKind::Constructor => {
                    for p in &m.value.params.items {
                        if let (BindingPattern::BindingIdentifier(id), Some(class)) =
                            (&p.pattern, p.type_annotation.as_ref().and_then(|t| self.class_of(t)))
                        {
                            if p.accessibility.is_some() || p.readonly {
                                props.insert(id.name.to_string(), class);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        self.props.push(props);
        walk::walk_class(self, it);
        self.props.pop();
    }

    fn visit_assignment_expression(&mut self, it: &AssignmentExpression<'a>) {
        if let Some(member) = it.left.as_member_expression() {
            self.mutation(member, it.left.span());
        }
        walk::walk_assignment_expression(self, it);
    }

    fn visit_update_expression(&mut self, it: &UpdateExpression<'a>) {
        if let Some(member) = it.argument.as_member_expression() {
            self.mutation(member, it.span);
        }
        walk::walk_update_expression(self, it);
    }

    fn visit_unary_expression(&mut self, it: &UnaryExpression<'a>) {
        if let Some(member) =
            unwrap_expr(&it.argument).as_member_expression().filter(|_| it.operator == oxc_syntax::operator::UnaryOperator::Delete)
        {
            self.mutation(member, it.argument.span());
        }
        walk::walk_unary_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let Expression::StaticMemberExpression(m) = unwrap_expr(&it.callee) {
            if let Some(base) = self.typed(&m.object) {
                let line = self.line(m.property.span.start);
                let scope = self.scope();
                self.model.calls.push(Call { from: self.current, base, method: m.property.name.to_string(), line, scope });
            }
            if let Some(member) = unwrap_expr(&m.object).as_member_expression().filter(|_| MUTATORS.contains(&m.property.name.as_str())) {
                self.mutation(member, oxc_span::Span::new(it.span.start, m.property.span.end));
            }
        }
        walk::walk_call_expression(self, it);
    }
}

fn imported_name(n: &ModuleExportName) -> String {
    n.name().to_string()
}

/// Adds a thing, and the symbol that names it.
fn thing(
    model: &mut FileModel,
    origins: &mut HashMap<SymbolId, Origin>,
    lines: &Lines,
    id: Option<&BindingIdentifier>,
    name: &str,
    kind: ThingKind,
    at: u32,
) -> usize {
    model.things.push(Thing {
        name: name.to_string(),
        kind,
        line: lines.line(at as usize),
        class: None,
        instance_of: None,
        forwards: false,
        component: false,
    });
    let index = model.things.len() - 1;
    if let Some(symbol) = id.and_then(|id| id.symbol_id.get()) {
        origins.insert(symbol, Origin::Local(index));
    }
    index
}

/// The things a declaration adds, each with the span whose code is its own.
fn declare(
    model: &mut FileModel,
    origins: &mut HashMap<SymbolId, Origin>,
    lines: &Lines,
    jsx: bool,
    decl: &Declaration,
) -> Vec<(oxc_span::Span, usize)> {
    let mut out = vec![];
    match decl {
        Declaration::FunctionDeclaration(f) => {
            if let Some(id) = &f.id {
                let i = thing(model, origins, lines, Some(id), &id.name, ThingKind::Function, f.span.start);
                if let Some(body) = &f.body {
                    model.things[i].forwards = forwards(body);
                    model.things[i].component = jsx && id.name.starts_with(char::is_uppercase) && returns_jsx(body);
                }
                out.push((f.span, i));
            }
        }
        Declaration::ClassDeclaration(c) => {
            if let Some(id) = &c.id {
                let i = thing(model, origins, lines, Some(id), &id.name, ThingKind::Class, c.span.start);
                model.things[i].class = Some(read_class(c, lines));
                out.push((c.span, i));
            }
        }
        Declaration::VariableDeclaration(v) => {
            for d in &v.declarations {
                let BindingPattern::BindingIdentifier(id) = &d.id else {
                    // `const { a, b } = …`: values without code of their own.
                    d.id.bound_names(&mut |id| {
                        thing(model, origins, lines, Some(id), &id.name, ThingKind::Value, d.span.start);
                    });
                    continue;
                };
                let (kind, body) = match d.init.as_ref().map(unwrap_expr) {
                    Some(Expression::ArrowFunctionExpression(a)) => (ThingKind::Function, Some(&*a.body)),
                    Some(Expression::FunctionExpression(f)) => (ThingKind::Function, f.body.as_deref()),
                    Some(Expression::ClassExpression(_)) => (ThingKind::Class, None),
                    _ => (ThingKind::Value, None),
                };
                let i = thing(model, origins, lines, Some(id), &id.name, kind, d.span.start);
                if let Some(Expression::ClassExpression(c)) = d.init.as_ref().map(unwrap_expr) {
                    model.things[i].class = Some(read_class(c, lines));
                }
                if let Some(body) = body {
                    model.things[i].forwards = forwards(body);
                    model.things[i].component = jsx && id.name.starts_with(char::is_uppercase) && returns_jsx(body);
                }
                out.push((d.span, i));
            }
        }
        Declaration::TSTypeAliasDeclaration(t) => {
            out.push((t.span, thing(model, origins, lines, Some(&t.id), &t.id.name, ThingKind::Type, t.span.start)))
        }
        Declaration::TSInterfaceDeclaration(t) => {
            out.push((t.span, thing(model, origins, lines, Some(&t.id), &t.id.name, ThingKind::Type, t.span.start)))
        }
        Declaration::TSEnumDeclaration(t) => {
            out.push((t.span, thing(model, origins, lines, Some(&t.id), &t.id.name, ThingKind::Value, t.span.start)))
        }
        _ => {}
    }
    out
}

/// Reads one file, or None when it does not parse.
pub fn read(path: &str, src: &str) -> Option<FileModel> {
    crate::js::parse(path, src, |program| {
        let semantic = SemanticBuilder::new().build(program).semantic;
        let scoping = semantic.scoping();
        let lines = Lines::new(src);
        let mut model = FileModel::default();
        let mut origins: HashMap<SymbolId, Origin> = HashMap::new();
        let jsx = is_jsx_file(path);
        let mut owners: Vec<Vec<(oxc_span::Span, usize)>> = Vec::new();
        let mut pending_local_exports: Vec<(String, String)> = vec![];
        for statement in &program.body {
            let mut owned = vec![];
            match statement {
                Statement::ImportDeclaration(d) => {
                    for s in d.specifiers.iter().flatten() {
                        let (local, imported) = match s {
                            ImportDeclarationSpecifier::ImportSpecifier(s) => (&s.local, Imported::Name(imported_name(&s.imported))),
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => (&s.local, Imported::Name("default".into())),
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => (&s.local, Imported::Namespace),
                        };
                        model.bindings.push(Binding { spec: d.source.value.to_string(), imported });
                        if let Some(symbol) = local.symbol_id.get() {
                            origins.insert(symbol, Origin::Import(model.bindings.len() - 1));
                        }
                    }
                }
                Statement::ExportNamedDeclaration(d) => {
                    if let Some(decl) = &d.declaration {
                        owned = declare(&mut model, &mut origins, &lines, jsx, decl);
                        for (_, i) in &owned {
                            model.exports.push(Export::Local { exported: model.things[*i].name.clone(), origin: Origin::Local(*i) });
                        }
                        if let Declaration::VariableDeclaration(v) = decl {
                            for d in &v.declarations {
                                if !matches!(d.id, BindingPattern::BindingIdentifier(_)) {
                                    d.id.bound_names(&mut |id| pending_local_exports.push((id.name.to_string(), id.name.to_string())));
                                }
                            }
                        }
                    }
                    for s in &d.specifiers {
                        let exported = imported_name(&s.exported);
                        match &d.source {
                            Some(source) => model.exports.push(Export::From {
                                exported,
                                spec: source.value.to_string(),
                                imported: Imported::Name(imported_name(&s.local)),
                            }),
                            None => pending_local_exports.push((imported_name(&s.local), exported)),
                        }
                    }
                }
                Statement::ExportAllDeclaration(d) => match &d.exported {
                    Some(name) => model.exports.push(Export::From {
                        exported: imported_name(name),
                        spec: d.source.value.to_string(),
                        imported: Imported::Namespace,
                    }),
                    None => model.exports.push(Export::Star { spec: d.source.value.to_string() }),
                },
                Statement::ExportDefaultDeclaration(d) => match &d.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                        let name = f.id.as_ref().map_or("default", |id| id.name.as_str());
                        let i = thing(&mut model, &mut origins, &lines, f.id.as_ref(), name, ThingKind::Function, f.span.start);
                        if let Some(body) = &f.body {
                            model.things[i].forwards = forwards(body);
                            model.things[i].component =
                                jsx && (name == "default" || name.starts_with(char::is_uppercase)) && returns_jsx(body);
                        }
                        model.exports.push(Export::Local { exported: "default".into(), origin: Origin::Local(i) });
                        owned.push((f.span, i));
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                        let name = c.id.as_ref().map_or("default", |id| id.name.as_str());
                        let i = thing(&mut model, &mut origins, &lines, c.id.as_ref(), name, ThingKind::Class, c.span.start);
                        model.things[i].class = Some(read_class(c, &lines));
                        model.exports.push(Export::Local { exported: "default".into(), origin: Origin::Local(i) });
                        owned.push((c.span, i));
                    }
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(t) => {
                        let i = thing(&mut model, &mut origins, &lines, Some(&t.id), &t.id.name, ThingKind::Type, t.span.start);
                        model.exports.push(Export::Local { exported: "default".into(), origin: Origin::Local(i) });
                        owned.push((t.span, i));
                    }
                    other => {
                        let expr = other.as_expression();
                        match expr.map(unwrap_expr) {
                            // `export default a`: a is declared elsewhere in the file, settled after.
                            Some(Expression::Identifier(id)) => pending_local_exports.push((id.name.to_string(), "default".into())),
                            _ => {
                                let kind = if matches!(
                                    expr.map(unwrap_expr),
                                    Some(Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_))
                                ) {
                                    ThingKind::Function
                                } else {
                                    ThingKind::Value
                                };
                                let i = thing(&mut model, &mut origins, &lines, None, "default", kind, d.span.start);
                                model.exports.push(Export::Local { exported: "default".into(), origin: Origin::Local(i) });
                                owned.push((d.span, i));
                            }
                        }
                    }
                },
                other => {
                    if let Some(decl) = other.as_declaration() {
                        owned = declare(&mut model, &mut origins, &lines, jsx, decl);
                    }
                }
            }
            owners.push(owned);
        }
        // `export { a as b }` and `export default a`: a local thing or an import passed on.
        let by_name: HashMap<&str, SymbolId> =
            scoping.iter_bindings_in(scoping.root_scope_id()).map(|s| (scoping.symbol_name(s), s)).collect();
        for (local, exported) in pending_local_exports {
            if let Some(origin) = by_name.get(local.as_str()).and_then(|s| origins.get(s)) {
                model.exports.push(Export::Local { exported, origin: origin.clone() });
            }
        }
        let mut walker =
            Walker { src, lines, scoping, model, origins, typed: HashMap::new(), current: None, props: vec![], scopes: vec![] };
        for (statement, owned) in program.body.iter().zip(owners) {
            if matches!(statement, Statement::ImportDeclaration(_)) {
                continue;
            }
            // Re-exports forward names; they are not uses.
            if let Statement::ExportNamedDeclaration(d) = statement {
                if d.declaration.is_none() {
                    continue;
                }
            }
            if matches!(statement, Statement::ExportAllDeclaration(_)) {
                continue;
            }
            if owned.is_empty() {
                walker.current = None;
                walker.visit_statement(statement);
                continue;
            }
            // Each declarator or declaration is walked as its thing's code.
            let declarations: Vec<&VariableDeclarator> = match statement {
                Statement::VariableDeclaration(v) => v.declarations.iter().collect(),
                Statement::ExportNamedDeclaration(d) => match &d.declaration {
                    Some(Declaration::VariableDeclaration(v)) => v.declarations.iter().collect(),
                    _ => vec![],
                },
                _ => vec![],
            };
            if declarations.is_empty() {
                walker.current = owned.first().map(|(_, i)| *i);
                walker.visit_statement(statement);
                continue;
            }
            for d in declarations {
                walker.current = owned.iter().find(|(span, _)| *span == d.span).map(|(_, i)| *i);
                if let (Some(i), Some(init)) = (walker.current, &d.init) {
                    if let Some(class) = walker.new_of(init) {
                        walker.model.things[i].instance_of = Some(class);
                    }
                }
                walker.visit_variable_declarator(d);
            }
        }
        walker.model
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_things_uses_exports_and_mutations() {
        let src = "import { Queue } from './queue';\nimport * as fmt from './fmt';\nimport type { Row } from './row';\nexport const queue = new Queue();\nexport function admit(q: Queue, row: Row) {\n  q.items.push(row);\n  return fmt.line(row);\n}\nfunction other() { const Queue = 1; return Queue; }\nexport { other as renamed };\nexport * from './more';\n";
        let m = read("a.ts", src).unwrap();
        let names: Vec<&str> = m.things.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["queue", "admit", "other"]);
        assert_eq!(m.things[0].instance_of, Some(Origin::Import(0)));
        // `other` shadows Queue, so it uses nothing; admit uses Queue (type), Row (type) and fmt.line.
        let admit: Vec<(String, bool)> = m
            .uses
            .iter()
            .filter(|u| u.from == Some(1))
            .map(|u| (format!("{:?}{}", u.to, u.member.clone().unwrap_or_default()), u.type_only))
            .collect();
        assert_eq!(admit, [("Import(0)".to_string(), true), ("Import(2)".to_string(), true), ("Import(1)line".to_string(), false)]);
        assert!(m.uses.iter().all(|u| u.from != Some(2)));
        assert_eq!(m.mutations.len(), 1);
        assert_eq!((m.mutations[0].field.as_str(), m.mutations[0].line, m.mutations[0].code.as_str()), ("items", 6, "q.items.push"));
        assert!(m.exports.iter().any(|e| matches!(e, Export::Local { exported, origin: Origin::Local(2) } if exported == "renamed")));
        assert!(m.exports.iter().any(|e| matches!(e, Export::Star { spec } if spec == "./more")));
    }

    #[test]
    fn reads_a_class_fields_getters_and_working_methods() {
        let src = "export class RunQueue {\n  items: Job[] = [];\n  private head = 0;\n  constructor(public limit: number) {}\n  get all() { return this.items; }\n  push(job: Job) { this.items.push(job); this.head++; }\n  size() { return this.items.length; }\n}\n";
        let m = read("q.ts", src).unwrap();
        let class = m.things[0].class.as_ref().unwrap();
        let fields: Vec<(&str, bool)> = class.fields.iter().map(|(n, _, p)| (n.as_str(), *p)).collect();
        assert_eq!(fields, [("items", true), ("head", false), ("limit", true)]);
        assert_eq!(class.getters.get("all").map(String::as_str), Some("items"));
        let methods: Vec<(&str, bool)> = class.methods.iter().map(|(n, _, _, w)| (n.as_str(), *w)).collect();
        assert_eq!(methods, [("push", true), ("size", true)]);
    }
}
