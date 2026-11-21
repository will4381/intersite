//! A type written by hand beside a schema that already defines it: an interface or object type whose keys are exactly
//! the keys of a zod, valibot, yup or TypeBox object schema, or of a Drizzle table. The two drift the first time one
//! changes, and the compiler checks neither against the other. Derive the type from the schema instead.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use rayon::prelude::*;
use std::collections::BTreeSet;

use crate::text::{self, Lines};
use crate::{Answer, Finding, Request};

/// A type restating this few keys is likely a coincidence: `{ id, name }` is everywhere.
const MIN_KEYS: usize = 4;
/// Callees that build an object schema from an object of fields, and the derivation to suggest for each.
const SCHEMA_CALLS: [(&str, &str); 10] = [
    ("z.object", "z.infer<typeof {name}>"),
    ("z.strictObject", "z.infer<typeof {name}>"),
    ("v.object", "v.InferOutput<typeof {name}>"),
    ("v.strictObject", "v.InferOutput<typeof {name}>"),
    ("yup.object", "yup.InferType<typeof {name}>"),
    ("Type.Object", "Static<typeof {name}>"),
    ("t.Object", "Static<typeof {name}>"),
    ("pgTable", "typeof {name}.$inferSelect"),
    ("sqliteTable", "typeof {name}.$inferSelect"),
    ("mysqlTable", "typeof {name}.$inferSelect"),
];

struct Shape {
    name: String,
    keys: BTreeSet<String>,
    line: u32,
    /// For a schema, the derived type to write instead; None for a hand-written type.
    derive: Option<String>,
}

struct Collector<'s> {
    src: &'s str,
    lines: Lines,
    /// The variables being declared, innermost last, with where their initializer starts.
    names: Vec<(String, u32)>,
    shapes: Vec<Shape>,
}

fn key_of(key: &PropertyKey) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(id) => Some(id.name.to_string()),
        PropertyKey::StringLiteral(s) => Some(s.value.to_string()),
        _ => None,
    }
}

/// The static keys of an object literal, or None when one is computed or spread (the full set is unknown).
fn object_keys(obj: &ObjectExpression) -> Option<BTreeSet<String>> {
    obj.properties.iter().map(|p| match p {
        ObjectPropertyKind::ObjectProperty(p) if !p.computed => key_of(&p.key),
        _ => None,
    }).collect()
}

fn signature_keys(members: &[TSSignature]) -> Option<BTreeSet<String>> {
    members.iter().map(|m| match m {
        TSSignature::TSPropertySignature(p) if !p.computed => key_of(&p.key),
        _ => None,
    }).collect()
}

impl<'a> Visit<'a> for Collector<'_> {
    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        let name = it.id.get_binding_identifier().map(|b| b.name.to_string());
        self.names.push((name.unwrap_or_default(), it.init.as_ref().map_or(u32::MAX, |i| i.span().start)));
        walk::walk_variable_declarator(self, it);
        self.names.pop();
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let callee = &self.src[it.callee.span().start as usize..it.callee.span().end as usize];
        if let Some((_, derive)) = SCHEMA_CALLS.iter().find(|(c, _)| callee == *c || callee.ends_with(&format!(".{c}")) && c.contains('.')) {
            // A Drizzle table takes its name first and its columns second.
            let fields = it.arguments.iter().filter_map(|a| a.as_expression()).find_map(|e| match e {
                Expression::ObjectExpression(o) => Some(o),
                _ => None,
            });
            // Only the variable's own value, `const User = z.object({…}).strict()`: a schema inline in a route's
            // validator is named by the route, not by what it validates.
            let name = self.names.last().filter(|(_, at)| *at == it.span.start).map(|(n, _)| n.clone()).unwrap_or_default();
            if let (Some(keys), false) = (fields.and_then(|o| object_keys(o)), name.is_empty()) {
                let line = self.lines.line(it.span.start as usize);
                self.shapes.push(Shape { name: name.clone(), keys, line, derive: Some(derive.replace("{name}", &name)) });
            }
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_ts_interface_declaration(&mut self, it: &TSInterfaceDeclaration<'a>) {
        if it.extends.is_empty() && it.type_parameters.is_none() {
            if let Some(keys) = signature_keys(&it.body.body) {
                self.shapes.push(Shape { name: it.id.name.to_string(), keys, line: self.lines.line(it.span.start as usize), derive: None });
            }
        }
        walk::walk_ts_interface_declaration(self, it);
    }

    fn visit_ts_type_alias_declaration(&mut self, it: &TSTypeAliasDeclaration<'a>) {
        if let (TSType::TSTypeLiteral(lit), None) = (&it.type_annotation, &it.type_parameters) {
            if let Some(keys) = signature_keys(&lit.members) {
                self.shapes.push(Shape { name: it.id.name.to_string(), keys, line: self.lines.line(it.span.start as usize), derive: None });
            }
        }
        walk::walk_ts_type_alias_declaration(self, it);
    }
}

fn shapes(path: &str, src: &str) -> Vec<Shape> {
    crate::js::parse(path, src, |program| {
        let mut c = Collector { src, lines: Lines::new(src), names: vec![], shapes: vec![] };
        c.visit_program(program);
        c.shapes
    })
    .unwrap_or_default()
}

type Located = (String, Shape);

pub fn run(request: &Request) -> Result<Answer, String> {
    let all: Vec<(String, Shape)> = request
        .files
        .par_iter()
        .filter(|f| f.ends_with(".ts") || f.ends_with(".tsx") || f.ends_with(".mts") || f.ends_with(".cts"))
        .filter_map(|file| {
            let src = text::read(&request.root, file)?;
            Some(shapes(file, &src).into_iter().filter(|s| s.keys.len() >= MIN_KEYS).map(|s| (file.clone(), s)).collect::<Vec<_>>())
        })
        .flatten()
        .collect();
    let (schemas, types): (Vec<&Located>, Vec<&Located>) = all.iter().partition(|(_, s)| s.derive.is_some());
    // Within one package: another package may not be able to import the schema, and mirrors it on purpose.
    let mut packages = std::collections::HashMap::new();
    let schemas: Vec<(&Located, String)> = schemas.into_iter().map(|x| (x, crate::decisions::package_of(&request.root, &x.0, &mut packages))).collect();
    let mut findings = Vec::new();
    let mut seen = BTreeSet::new();
    for (tfile, t) in &types {
        let package = crate::decisions::package_of(&request.root, tfile, &mut packages);
        let Some((sfile, s)) = schemas.iter().filter(|(_, p)| *p == package).map(|(x, _)| (&x.0, &x.1)).find(|(_, s)| s.keys == t.keys) else { continue };
        if !(request.changed(tfile, t.line) || request.changed(sfile, s.line)) || !seen.insert((tfile.clone(), t.name.clone())) {
            continue;
        }
        let derive = s.derive.as_deref().unwrap_or("");
        findings.push(Finding {
            file: tfile.clone(),
            line: t.line,
            target: format!("{tfile}:schema-drift:{}", t.name),
            message: format!("{tfile}:{} {} restates by hand the {} keys of {} at {sfile}:{}, so the two drift the first time one changes and nothing checks one against the other: derive it, type {} = {derive}", t.line, t.name, t.keys.len(), s.name, s.line, t.name),
        });
    }
    Ok(Answer { findings, summary: format!("{} schemas and {} object types compared", schemas.len(), types.len()), data: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_schema_keys_and_hand_written_types() {
        let got = shapes("a.ts", "export const UserSchema = z.object({ id: z.string(), email: z.string(), name: z.string() }).strict();\nexport interface User { id: string; email: string; name: string }\nexport const users = pgTable('users', { id: uuid('id'), email: text('email'), plan: text('plan') });\ntype Row = { [k: string]: string };\nexport const routes = app.post('/x', validate(z.object({ a: z.string(), b: z.string(), c: z.string() })));\n");
        let summary: Vec<(String, usize, bool)> = got.iter().map(|s| (s.name.clone(), s.keys.len(), s.derive.is_some())).collect();
        assert_eq!(summary, vec![("UserSchema".into(), 3, true), ("User".into(), 3, false), ("users".into(), 3, true)]);
    }
}
