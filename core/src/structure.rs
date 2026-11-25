//! The structure check: code that is hard to read because of how its parts know each other, after deslop-please and
//! *A Philosophy of Software Design* (deep modules, narrow interfaces). A module is a file, or a folder with what is
//! in it (its `index` file is the folder's own code).
//!
//! - module-cycle: files or folders side by side that use each other in a circle, so there is no order to read them
//!   in. What a folder and the files in it use of each other is no circle; neither are workspace packages.
//! - tangle: declarations that know each other in a circle across files where module-cycle cannot see it (a folder's
//!   index and a file inside it), or more of them than a reader holds in mind.
//! - field-leak: code outside a class that changes one of its fields (assigns it, `++`, `delete`, `push`/`set`/…),
//!   when the class keeps other fields to itself and has methods that work on them. Reading a field is no leak.
//! - shallow-module: a folder whose outside code uses more functions than a reader holds in mind, about as many as it
//!   hides, in a list that long (more things, or more functions of one thing).
//!
//! A change is judged by what it adds: a circle one of whose ties only the change's lines make, a field changed from
//! outside on an added line, a folder that is shallow and shows a function it did not show before.

use rayon::prelude::*;
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use crate::graph::{self, Graph, Target};
use crate::things::{self, Export, FileModel, Imported, Origin, ThingKind, Typed};
use crate::{rel, text, Answer, Finding, Request};

/// What a reader holds in mind at once (Miller, 1956): a circle or a list longer than this is too much.
const HELD_IN_MIND: usize = 7;

/// Tests, stories, fixtures, mocks, declarations and generated code: none of it is the design being judged.
static NOT_DESIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)(?:[\w-]+-test(?:s|ing)?|tests?|__tests__|__mocks__|__fixtures__|fixtures?|e2e|stories|storybook|\.storybook|generated|__generated__|node_modules|dist|build|out|coverage)/|\.(?:test|spec|stories|story|bench|config|d|gen|generated)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$").unwrap()
});
static INDEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)index\.[cm]?[jt]sx?$").unwrap());

type Gid = usize;

#[derive(Clone, PartialEq, Eq, Debug)]
enum Res {
    Thing(Gid),
    File(String),
    Unknown,
}

/// The uses one module makes of another: what it names, where, and whether only the change's lines make it.
#[derive(Default)]
struct Tie {
    names: BTreeSet<String>,
    sites: BTreeSet<(String, u32)>,
    all_new: bool,
}

impl Tie {
    fn add(&mut self, name: &str, file: &str, line: u32, new: bool) {
        if self.sites.is_empty() {
            self.all_new = true;
        }
        self.all_new &= new;
        self.names.insert(name.to_string());
        self.sites.insert((file.to_string(), line));
    }

    fn site(&self) -> &(String, u32) {
        self.sites.first().expect("a tie has a site")
    }

    fn names(&self) -> String {
        let names: Vec<&str> = self.names.iter().map(String::as_str).collect();
        listed(&names)
    }
}

/// `a, b, c and 2 more`.
fn listed(names: &[&str]) -> String {
    let shown: Vec<&str> = names.iter().take(3).copied().collect();
    match names.len() {
        0 => String::new(),
        1 => shown[0].to_string(),
        n if n <= 3 => format!("{} and {}", shown[..n - 1].join(", "), shown[n - 1]),
        n => format!("{} and {} more", shown.join(", "), n - 3),
    }
}

/// Strongly connected components of two or more nodes, iteratively (Tarjan), each sorted.
fn circles(edges: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let n = edges.len();
    let (mut index, mut low, mut on) = (vec![usize::MAX; n], vec![0; n], vec![false; n]);
    let (mut stack, mut out, mut next) = (vec![], vec![], 0);
    for start in 0..n {
        if index[start] != usize::MAX {
            continue;
        }
        let mut work = vec![(start, 0usize)];
        while let Some(&mut (v, ref mut i)) = work.last_mut() {
            if *i == 0 && index[v] == usize::MAX {
                index[v] = next;
                low[v] = next;
                next += 1;
                stack.push(v);
                on[v] = true;
            }
            if let Some(&w) = edges[v].get(*i) {
                *i += 1;
                if index[w] == usize::MAX {
                    work.push((w, 0));
                } else if on[w] {
                    low[v] = low[v].min(index[w]);
                }
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                low[parent] = low[parent].min(low[v]);
            }
            if low[v] == index[v] {
                let mut component = vec![];
                loop {
                    let w = stack.pop().expect("on the stack");
                    on[w] = false;
                    component.push(w);
                    if w == v {
                        break;
                    }
                }
                if component.len() > 1 {
                    component.sort_unstable();
                    out.push(component);
                }
            }
        }
    }
    out
}

struct Model<'g> {
    graph: &'g Graph,
    files: HashMap<String, FileModel>,
    /// By Gid: the file and the thing's index there.
    things: Vec<(String, usize)>,
    gid: HashMap<(String, usize), Gid>,
    memo: std::cell::RefCell<HashMap<(String, String), Res>>,
}

impl Model<'_> {
    /// The repository file an import of `spec` in `file` leads to.
    fn target(&self, file: &str, spec: &str) -> Option<String> {
        let module = self.graph.modules.get(file)?;
        let targets = self.graph.targets.get(file)?;
        module.imports.iter().zip(targets).find(|(i, _)| i.spec == spec).and_then(|(_, t)| match t {
            Target::File(f) => Some(f.clone()),
            _ => None,
        })
    }

    fn thing(&self, gid: Gid) -> &things::Thing {
        let (file, i) = &self.things[gid];
        &self.files[file].things[*i]
    }

    fn file_of(&self, gid: Gid) -> &str {
        &self.things[gid].0
    }

    /// What `name`, exported by `file`, is: followed through re-exports and barrels to where it is declared.
    fn resolve(&self, file: &str, name: &str, depth: u32) -> Res {
        let key = (file.to_string(), name.to_string());
        if let Some(r) = self.memo.borrow().get(&key) {
            return r.clone();
        }
        let r = self.resolve_uncached(file, name, depth);
        self.memo.borrow_mut().insert(key, r.clone());
        r
    }

    fn resolve_uncached(&self, file: &str, name: &str, depth: u32) -> Res {
        let Some(model) = self.files.get(file) else {
            return if self.graph.modules.contains_key(file) && !NOT_DESIGN.is_match(file) {
                Res::File(file.to_string())
            } else {
                Res::Unknown
            };
        };
        if depth > 12 {
            return Res::Unknown;
        }
        for export in &model.exports {
            match export {
                Export::Local { exported, origin } if exported == name => return self.origin(file, origin, depth + 1),
                Export::From { exported, spec, imported } if exported == name => {
                    let Some(target) = self.target(file, spec) else { return Res::Unknown };
                    return match imported {
                        Imported::Name(n) => self.resolve(&target, n, depth + 1),
                        Imported::Namespace => Res::File(target),
                    };
                }
                _ => {}
            }
        }
        for export in &model.exports {
            if let Export::Star { spec } = export {
                if let Some(target) = self.target(file, spec) {
                    if let r @ Res::Thing(_) = self.resolve(&target, name, depth + 1) {
                        return r;
                    }
                }
            }
        }
        Res::File(file.to_string())
    }

    /// What a name of `file` is: one of its things, or what an import of it leads to.
    fn origin(&self, file: &str, origin: &Origin, depth: u32) -> Res {
        match origin {
            Origin::Local(i) => self.gid.get(&(file.to_string(), *i)).map_or(Res::Unknown, |&g| Res::Thing(g)),
            Origin::Import(b) => {
                let binding = &self.files[file].bindings[*b];
                let Some(target) = self.target(file, &binding.spec) else { return Res::Unknown };
                match &binding.imported {
                    Imported::Name(n) => self.resolve(&target, n, depth),
                    Imported::Namespace => Res::File(target),
                }
            }
        }
    }

    /// The class an instance-typed expression holds.
    fn class_of(&self, file: &str, typed: &Typed) -> Option<Gid> {
        let (origin, instance) = match typed {
            Typed::Instance(o) => (o, true),
            Typed::Value(o) => (o, false),
        };
        let Res::Thing(g) = self.origin(file, origin, 0) else { return None };
        if instance {
            return (self.thing(g).kind == ThingKind::Class).then_some(g);
        }
        // A value: an instance when it was made with `new` of a class.
        let value = self.thing(g);
        let made = value.instance_of.as_ref()?;
        match self.origin(self.file_of(g), made, 0) {
            Res::Thing(c) if self.thing(c).kind == ThingKind::Class => Some(c),
            _ => None,
        }
    }
}

/// The module a file is: its folder, for an index file; the file itself otherwise.
fn node(file: &str) -> &str {
    if INDEX.is_match(file) {
        graph::parent(file)
    } else {
        file
    }
}

fn segments(path: &str) -> Vec<&str> {
    if path.is_empty() {
        vec![]
    } else {
        path.split('/').collect()
    }
}

/// The folder holding modules `a` and `b`, and its children that hold each, unless one holds the other.
fn siblings(a: &str, b: &str, package: &str) -> Option<(String, String, String)> {
    let (sa, sb) = (segments(a), segments(b));
    let common = sa.iter().zip(&sb).take_while(|(x, y)| x == y).count();
    if common == sa.len() || common == sb.len() {
        return None;
    }
    let parent = sa[..common].join("/");
    // Above the package's own folder, the two are in different packages, which their package.json files order.
    if segments(package).len() > common {
        return None;
    }
    let child = |s: &[&str]| s[..=common].join("/");
    Some((parent, child(&sa), child(&sb)))
}

pub fn run(request: &Request) -> Result<Answer, String> {
    let graph = Graph::build(&request.root, &request.files);
    let prefix = request.prefix.as_str();
    let mut paths: Vec<&String> = graph.modules.keys().filter(|f| !NOT_DESIGN.is_match(f)).collect();
    paths.sort();
    let files: HashMap<String, FileModel> =
        paths.par_iter().filter_map(|f| Some(((*f).clone(), things::read(f, &text::read(&request.root, f)?)?))).collect();
    let mut names: Vec<String> = files.keys().cloned().collect();
    names.sort();
    let mut things_list = vec![];
    let mut gid = HashMap::new();
    for f in &names {
        for i in 0..files[f].things.len() {
            gid.insert((f.clone(), i), things_list.len());
            things_list.push((f.clone(), i));
        }
    }
    let model = Model { graph: &graph, files, things: things_list, gid, memo: Default::default() };
    let ordered: Vec<&String> = names.iter().collect();
    let changed = |file: &str, line: u32| request.changed(file, line);
    let package_of = |file: &str| graph.packages_of(file).first().map_or(String::new(), |p| p.dir.clone());

    // Every use, resolved: (user file, user thing, what it names, line, type only).
    struct Edge {
        file: String,
        user: Option<Gid>,
        used: Res,
        line: u32,
        type_only: bool,
        scope: u32,
    }
    let mut edges: Vec<Edge> = vec![];
    for f in &ordered {
        let m = &model.files[*f];
        for u in &m.uses {
            let used = match (&u.to, &u.member) {
                (Origin::Import(b), Some(member)) => match model.target(f, &m.bindings[*b].spec) {
                    Some(target) => model.resolve(&target, member, 0),
                    None => Res::Unknown,
                },
                (origin, _) => model.origin(f, origin, 0),
            };
            if used == Res::Unknown {
                continue;
            }
            let user = u.from.and_then(|i| model.gid.get(&((*f).clone(), i)).copied());
            edges.push(Edge { file: (*f).clone(), user, used, line: u.line, type_only: u.type_only, scope: u.scope });
        }
    }
    let name_of = |res: &Res| -> String {
        match res {
            Res::Thing(g) => model.thing(*g).name.clone(),
            Res::File(f) => rel(prefix, f),
            Res::Unknown => String::new(),
        }
    };
    let file_of_res = |res: &Res| -> Option<String> {
        match res {
            Res::Thing(g) => Some(model.file_of(*g).to_string()),
            Res::File(f) => Some(f.clone()),
            Res::Unknown => None,
        }
    };

    let mut findings = vec![];

    // module-cycle: by parent folder, the ties between its children.
    let mut ties: BTreeMap<String, BTreeMap<(String, String), Tie>> = BTreeMap::new();
    // Circles are counted by what runs: a type import is erased when compiled, so it orders nothing.
    for e in edges.iter().filter(|e| !e.type_only) {
        let Some(used_file) = file_of_res(&e.used) else { continue };
        if used_file == e.file || !model.files.contains_key(&used_file) {
            continue;
        }
        let package = package_of(&e.file);
        if package != package_of(&used_file) {
            continue;
        }
        if let Some((parent, a, b)) = siblings(node(&e.file), node(&used_file), &package) {
            ties.entry(parent).or_default().entry((a, b)).or_default().add(&name_of(&e.used), &e.file, e.line, changed(&e.file, e.line));
        }
    }
    // Sibling pairs that are in a reported circle, so tangle leaves them to module-cycle.
    let mut cycles = 0;
    for (parent, ties) in &ties {
        let mut children: Vec<&String> = ties.keys().flat_map(|(a, b)| [a, b]).collect();
        children.sort();
        children.dedup();
        let place = |c: &String| children.binary_search(&c).expect("a tied child");
        let mut uses = vec![vec![]; children.len()];
        for (a, b) in ties.keys() {
            uses[place(a)].push(place(b));
        }
        for circle in circles(&uses) {
            let members: Vec<&String> = circle.iter().map(|&i| children[i]).collect();
            let inside: Vec<(&(String, String), &Tie)> =
                ties.iter().filter(|((a, b), _)| members.contains(&a) && members.contains(&b)).collect();
            // The tie to report: one only the change makes, else (judging everything) the cheapest to cut.
            let reported = match &request.added {
                Some(_) => inside.iter().filter(|(_, t)| t.all_new).min_by_key(|(_, t)| (t.names.len(), t.site().clone())),
                None => inside.iter().min_by_key(|(_, t)| (t.names.len(), t.site().clone())),
            };
            let Some(((user, used), tie)) = reported else { continue };
            cycles += 1;
            let (file, line) = tie.site();
            let short = |c: &str| rel(prefix, c);
            // Members by their names in the folder that holds them.
            let local = |c: &str| c.rsplit('/').next().unwrap_or(c).to_string();
            let mut names: Vec<String> = members.iter().map(|m| short(m)).collect();
            names.sort();
            let back: usize = inside.iter().filter(|((a, _), _)| a == used).map(|(_, t)| t.sites.len()).sum();
            let place = match short(parent) {
                p if parent.is_empty() || p.is_empty() || p == "." => String::new(),
                p => format!(" in {p}"),
            };
            let message = if members.len() == 2 {
                format!(
                    "{} and {}{place} use each other in a circle: {} uses {} from {} here, and {} the other way. Decide which one sits below the other and move what it takes from the one above into it (or into a module both use)",
                    local(user),
                    local(used),
                    local(user),
                    tie.names(),
                    local(used),
                    if back == 1 { "1 use goes".to_string() } else { format!("{back} uses go") }
                )
            } else {
                let mut locals: Vec<String> = members.iter().map(|m| local(m)).collect();
                locals.sort();
                let locals: Vec<&str> = locals.iter().map(String::as_str).collect();
                format!(
                    "{} modules{place} use each other in a circle ({}): {} uses {} from {} here. Put them in an order and move what goes against it, so each uses only those below it",
                    members.len(),
                    listed(&locals),
                    local(user),
                    tie.names(),
                    local(used)
                )
            };
            findings.push(Finding { file: file.clone(), line: *line, target: format!("module-cycle {}", names.join(" ")), message });
        }
    }

    // tangle: declarations that know each other in a circle.
    let mut knows: Vec<Vec<usize>> = vec![vec![]; model.things.len()];
    let mut thing_ties: HashMap<(Gid, Gid), Tie> = HashMap::new();
    for e in edges.iter().filter(|e| !e.type_only) {
        if let (Some(user), Res::Thing(used)) = (e.user, &e.used) {
            if user != *used {
                knows[user].push(*used);
                thing_ties.entry((user, *used)).or_default().add(&model.thing(*used).name, &e.file, e.line, changed(&e.file, e.line));
            }
        }
    }
    for list in &mut knows {
        list.sort_unstable();
        list.dedup();
    }
    let mut tangles = 0;
    for members in circles(&knows) {
        let files: BTreeSet<&str> = members.iter().map(|&g| model.file_of(g)).collect();
        let inside: Vec<(&(Gid, Gid), &Tie)> = members
            .iter()
            .flat_map(|&a| knows[a].iter().filter(|b| members.binary_search(b).is_ok()).map(move |&b| (a, b)))
            .filter_map(|k| thing_ties.get_key_value(&k))
            .collect();
        // A circle across files whose every tie is between modules side by side is module-cycle's.
        let crosses_into_parent = inside.iter().any(|((a, b), _)| {
            let (fa, fb) = (model.file_of(*a), model.file_of(*b));
            fa != fb && siblings(node(fa), node(fb), &package_of(fa)).is_none()
        });
        if !(members.len() > HELD_IN_MIND || (files.len() > 1 && crosses_into_parent)) {
            continue;
        }
        let reported = match &request.added {
            Some(_) => inside.iter().filter(|(_, t)| t.all_new).min_by_key(|(_, t)| (t.names.len(), t.site().clone())),
            None => inside.iter().min_by_key(|(_, t)| (t.names.len(), t.site().clone())),
        };
        let Some(((user, used), tie)) = reported else { continue };
        tangles += 1;
        let (file, line) = tie.site();
        let label = |g: Gid| format!("{} ({})", model.thing(g).name, rel(prefix, model.file_of(g)));
        let mut names: Vec<String> =
            members.iter().map(|&g| format!("{}:{}", rel(prefix, model.file_of(g)), model.thing(g).name)).collect();
        names.sort();
        let message = if members.len() == 2 {
            format!(
                "{} and {} know each other in a circle: here {} uses {}, and {} uses {} back. Break it: let the code that needs both call them, or pass in what one needs as an argument",
                label(*user),
                label(*used),
                model.thing(*user).name,
                model.thing(*used).name,
                model.thing(*used).name,
                model.thing(*user).name
            )
        } else {
            let short: Vec<&str> = members.iter().map(|&g| model.thing(g).name.as_str()).collect();
            format!(
                "{} declarations across {} know each other in a circle ({}): here {} uses {}. A reader cannot learn one without the others; give them an order, each using only those below it",
                members.len(),
                if files.len() == 1 { "one file".to_string() } else { format!("{} files", files.len()) },
                listed(&short),
                model.thing(*user).name,
                model.thing(*used).name
            )
        };
        findings.push(Finding { file: file.clone(), line: *line, target: format!("tangle {}", names.join(" ")), message });
    }

    // field-leak: fields changed from outside their class.
    let mut leaks: BTreeMap<(Gid, String), Vec<_>> = BTreeMap::new();
    for f in &ordered {
        for m in &model.files[*f].mutations {
            let Some(class) = model.class_of(f, &m.base) else { continue };
            let info = model.thing(class).class.as_ref().expect("a class has its fields read");
            let field = info.getters.get(&m.field).cloned().unwrap_or_else(|| m.field.clone());
            let inside = model.file_of(class) == f.as_str() && m.from == Some(model.things[class].1);
            if inside || !info.fields.iter().any(|(n, _, public)| *n == field && *public) {
                continue;
            }
            leaks.entry((class, field)).or_default().push(((*f).clone(), m.line, m.code.clone()));
        }
    }
    let mut leaked_fields: HashMap<Gid, HashSet<&str>> = HashMap::new();
    for (class, field) in leaks.keys() {
        leaked_fields.entry(*class).or_default().insert(field);
    }
    let mut leak_count = 0;
    for ((class, field), sites) in &leaks {
        let info = model.thing(*class).class.as_ref().expect("a class");
        let works = info.methods.iter().any(|(_, _, _, works)| *works);
        let kept = info.fields.iter().any(|(n, _, _)| !leaked_fields[class].contains(n.as_str()));
        if info.decorated || !works || !kept {
            continue;
        }
        let at = match &request.added {
            Some(_) => sites.iter().find(|(f, l, _)| changed(f, *l)),
            None => sites.first(),
        };
        let Some((file, line, code)) = at else { continue };
        leak_count += 1;
        let name = &model.thing(*class).name;
        let files: BTreeSet<&str> = sites.iter().map(|(f, _, _)| f.as_str()).collect();
        let more = if sites.len() > 1 {
            format!(
                " ({} places in {})",
                sites.len(),
                if files.len() == 1 { "1 file".to_string() } else { format!("{} files", files.len()) }
            )
        } else {
            String::new()
        };
        findings.push(Finding {
            file: file.clone(),
            line: *line,
            target: format!("field-leak {}:{name}.{field}", rel(prefix, model.file_of(*class))),
            message: format!("`{code}` changes {name}'s `{field}` from outside {name}{more}. Give {name} a method that makes this change, and keep `{field}` to itself, so its rules live in one place"),
        });
    }

    // shallow-module: per folder, the functions in it, and per caller outside it, the ones it uses.
    struct Function {
        gid: Gid,
        name: String,
        line: u32,
        private: bool,
        /// The class it is a method of.
        of: Option<Gid>,
    }
    let mut functions: Vec<Function> = vec![];
    let mut free: HashMap<Gid, usize> = HashMap::new();
    let mut methods: HashMap<(Gid, &str), usize> = HashMap::new();
    for (g, (file, i)) in model.things.iter().enumerate() {
        let t = &model.files[file].things[*i];
        match t.kind {
            ThingKind::Function if !t.forwards && !t.component => {
                free.insert(g, functions.len());
                functions.push(Function { gid: g, name: t.name.clone(), line: t.line, private: false, of: None });
            }
            ThingKind::Class => {
                for (m, line, private, _) in t.class.as_ref().map(|c| c.methods.as_slice()).unwrap_or_default() {
                    methods.insert((g, m.as_str()), functions.len());
                    functions.push(Function { gid: g, name: format!("{}.{m}", t.name), line: *line, private: *private, of: Some(g) });
                }
            }
            _ => {}
        }
    }
    /// Who uses a function: a declaration, or a file's top-level code.
    #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
    enum Caller {
        Thing(Gid, u32),
        Top(String, u32),
    }
    // Per function, its uses: (caller, file, line).
    let mut uses_of: Vec<Vec<(Caller, String, u32)>> = vec![vec![]; functions.len()];
    // Per free function, the types and classes it knows.
    let mut known: HashMap<Gid, BTreeSet<Gid>> = HashMap::new();
    let caller =
        |user: Option<Gid>, file: &str, scope: u32| user.map_or_else(|| Caller::Top(file.to_string(), scope), |g| Caller::Thing(g, scope));
    for e in &edges {
        if let Res::Thing(g) = e.used {
            if let Some(&f) = free.get(&g) {
                uses_of[f].push((caller(e.user, &e.file, e.scope), e.file.clone(), e.line));
            }
            if let Some(user) = e.user {
                if matches!(model.thing(g).kind, ThingKind::Type | ThingKind::Class) && model.thing(user).kind == ThingKind::Function {
                    known.entry(user).or_default().insert(g);
                }
            }
        }
    }
    for f in &ordered {
        let m = &model.files[*f];
        for call in &m.calls {
            let Some(class) = model.class_of(f, &call.base) else { continue };
            if let Some(&fun) = methods.get(&(class, call.method.as_str())) {
                let user = call.from.and_then(|i| model.gid.get(&((*f).clone(), i)).copied());
                if user != Some(class) {
                    uses_of[fun].push((caller(user, f, call.scope), (*f).clone(), call.line));
                }
            }
        }
    }
    let within = |file: &str, folder: &str| folder.is_empty() || file.starts_with(&format!("{folder}/"));
    let mut folders: BTreeSet<String> = BTreeSet::new();
    for f in &ordered {
        let package = package_of(f);
        let mut dir = graph::parent(f);
        while !dir.is_empty() && segments(dir).len() >= segments(&package).len() && dir.starts_with(prefix.trim_end_matches('/')) {
            folders.insert(dir.to_string());
            dir = graph::parent(dir);
        }
    }
    let caller_name = |c: &Caller| match c {
        Caller::Thing(g, _) => format!("{} ({})", model.thing(*g).name, rel(prefix, model.file_of(*g))),
        Caller::Top(f, _) => rel(prefix, f),
    };
    let mut shallow = 0;
    let mut deepest: Vec<&String> = folders.iter().collect();
    deepest.sort_by_key(|f| std::cmp::Reverse(segments(f).len()));
    let mut reported: HashSet<(Caller, Gid)> = HashSet::new();
    for folder in deepest {
        let inside: Vec<usize> = (0..functions.len()).filter(|&f| within(model.file_of(functions[f].gid), folder)).collect();
        if inside.len() <= HELD_IN_MIND {
            continue;
        }
        // Per caller outside the folder, per list it learns the folder by (a class's methods, or the free functions
        // that know one of the folder's types), the functions it uses.
        let mut by_caller: BTreeMap<(Caller, Gid), BTreeSet<usize>> = BTreeMap::new();
        let mut shown: BTreeSet<usize> = BTreeSet::new();
        for &f in &inside {
            let fun = &functions[f];
            if fun.private {
                continue;
            }
            let lists: Vec<Gid> = match fun.of {
                Some(class) => vec![class],
                None => known.get(&fun.gid).into_iter().flatten().filter(|t| within(model.file_of(**t), folder)).copied().collect(),
            };
            for (c, file, _) in &uses_of[f] {
                if within(file, folder) {
                    continue;
                }
                shown.insert(f);
                for &list in &lists {
                    by_caller.entry((c.clone(), list)).or_default().insert(f);
                }
            }
        }
        let hidden = inside.len() - shown.len();
        if shown.len() <= HELD_IN_MIND || hidden > shown.len() {
            continue;
        }
        let Some(((who, list), used)) = by_caller
            .iter()
            .filter(|(k, used)| used.len() > HELD_IN_MIND && !reported.contains(*k))
            .max_by_key(|(k, used)| (used.len(), std::cmp::Reverse((*k).clone())))
        else {
            continue;
        };
        reported.insert((who.clone(), *list));
        // A change is judged when it adds one of those functions, or one of that caller's uses of them.
        let site = |f: usize| uses_of[f].iter().filter(|(c, _, _)| c == who).map(|(_, file, line)| (file.clone(), *line)).min();
        let at = match &request.added {
            Some(_) => {
                let fresh = used.iter().find_map(|&f| {
                    let fun = &functions[f];
                    if changed(model.file_of(fun.gid), fun.line) {
                        return Some((model.file_of(fun.gid).to_string(), fun.line));
                    }
                    uses_of[f].iter().find(|(c, file, line)| c == who && changed(file, *line)).map(|(_, file, line)| (file.clone(), *line))
                });
                match fresh {
                    Some(at) => at,
                    None => continue,
                }
            }
            None => used.iter().filter_map(|&f| site(f)).min().expect("a caller has a use"),
        };
        shallow += 1;
        let name = rel(prefix, folder);
        let thing = &model.thing(*list).name;
        let mut names: Vec<&str> = used.iter().map(|&f| functions[f].name.rsplit('.').next().unwrap_or_default()).collect();
        names.sort();
        findings.push(Finding {
            file: at.0,
            line: at.1,
            target: format!("shallow-module {name} {thing}"),
            message: format!(
                "{} calls {} of {name}'s functions on {thing} ({}), and code outside {name} calls {} of its {}: the caller does {name}'s work step by step. Give {name} a few functions that each do a whole job with {thing}, and keep the steps inside",
                caller_name(who),
                used.len(),
                listed(&names),
                shown.len(),
                inside.len()
            ),
        });
    }

    for f in &mut findings {
        f.message = format!("{}:{} {}", rel(prefix, &f.file), f.line, f.message);
    }
    findings.sort_by(|a, b| (&a.file, a.line, &a.target).cmp(&(&b.file, b.line, &b.target)));
    Ok(Answer::new(
        findings,
        format!(
            "{} files, {} declarations: {cycles} module cycles, {tangles} tangles, {leak_count} field leaks, {shallow} shallow modules",
            model.files.len(),
            model.things.len()
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_on(files: &[(&str, &str)], added: Option<Vec<(&str, Vec<u32>)>>) -> Vec<Finding> {
        let root = text::temp_tree(&format!("structure-{}", files.len() * 31 + files[0].0.len()), files);
        let request = Request {
            command: "structure".into(),
            root,
            files: files.iter().map(|(f, _)| f.to_string()).collect(),
            added: added.map(|a| a.into_iter().map(|(f, l)| (f.to_string(), l.into_iter().collect())).collect()),
            prefix: String::new(),
            database_url: None,
            options: serde_json::Value::Null,
        };
        run(&request).unwrap().findings
    }

    #[test]
    fn circles_are_strongly_connected_components() {
        assert_eq!(circles(&[vec![1], vec![2], vec![0], vec![0]]), vec![vec![0, 1, 2]]);
        assert!(circles(&[vec![1], vec![]]).is_empty());
    }

    #[test]
    fn sibling_folders_that_use_each_other_are_a_module_cycle_and_a_folder_with_its_files_is_not() {
        let files = [
            ("src/lib/format.ts", "import { TONES } from '../components/badge';\nexport const format = (i: number) => TONES[i];\n"),
            (
                "src/components/badge.ts",
                "import { format } from '../lib/format';\nexport const TONES = ['a', 'b'];\nexport const badge = () => format(0);\n",
            ),
            ("src/views/card.ts", "import type { Row } from '../models/row';\nexport const card = (r: Row) => r;\n"),
            (
                "src/models/row.ts",
                "import { card } from '../views/card';\nexport type Row = { id: number };\nexport const show = () => card({ id: 1 });\n",
            ),
            ("src/kinds/index.ts", "import { wait } from './epoll';\nexport const poll = () => wait();\nexport type Kind = 1;\n"),
            ("src/kinds/epoll.ts", "import { poll } from './index';\nexport const wait = (): unknown => poll;\n"),
        ];
        let found = run_on(&files, None);
        let cycles: Vec<&Finding> = found.iter().filter(|f| f.target.starts_with("module-cycle")).collect();
        assert_eq!(cycles.len(), 1, "{found:?}");
        assert_eq!(cycles[0].target, "module-cycle src/components src/lib");
        assert!(cycles[0].message.starts_with("src/components/badge.ts:3 components and lib in src use each other in a circle: components uses format from lib here, and 1 use goes the other way."), "{}", cycles[0].message);
        // The folder and its file know each other: that is a tangle, not a module cycle.
        let tangles: Vec<&Finding> = found.iter().filter(|f| f.target.starts_with("tangle")).collect();
        assert_eq!(tangles.len(), 1, "{found:?}");
        assert_eq!(tangles[0].target, "tangle src/kinds/epoll.ts:wait src/kinds/index.ts:poll");
    }

    #[test]
    fn a_change_is_judged_by_the_tie_it_adds() {
        let files = [
            ("a/x.ts", "import { y } from '../b/y';\nexport const x = () => y();\nexport const z = 1;\n"),
            ("b/y.ts", "import { z } from '../a/x';\nexport const y = () => z;\n"),
        ];
        assert_eq!(run_on(&files, Some(vec![("a/x.ts", vec![3])])).len(), 0);
        let found = run_on(&files, Some(vec![("b/y.ts", vec![1, 2])]));
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].file.as_str(), found[0].line), ("b/y.ts", 2));
    }

    #[test]
    fn a_field_changed_from_outside_a_class_that_keeps_others_is_a_leak_and_a_read_is_not() {
        let files = [
            ("q/queue.ts", "export class RunQueue {\n  items: string[] = [];\n  private head = 0;\n  next() { this.head++; return this.items[this.head]; }\n}\nexport const queue = new RunQueue();\n"),
            ("sched/policy.ts", "import { RunQueue, queue } from '../q/queue';\nexport function admit(q: RunQueue, job: string) {\n  q.items.push(job);\n}\nexport const size = () => queue.items.length;\nexport const reset = () => { queue.items = []; };\n"),
            ("orm/user.ts", "@Entity()\nexport class User {\n  name = '';\n  private id = 0;\n  rename(n: string) { this.name = n + this.id; }\n}\n"),
            ("orm/save.ts", "import { User } from './user';\nexport const save = (u: User) => { u.name = 'x'; };\n"),
        ];
        let found = run_on(&files, None);
        let leaks: Vec<(&str, u32, &str)> =
            found.iter().filter(|f| f.target.starts_with("field-leak")).map(|f| (f.file.as_str(), f.line, f.target.as_str())).collect();
        assert_eq!(leaks, [("sched/policy.ts", 3, "field-leak q/queue.ts:RunQueue.items")], "{found:?}");
        assert!(
            found.iter().any(|f| f
                .message
                .starts_with("sched/policy.ts:3 `q.items.push` changes RunQueue's `items` from outside RunQueue (2 places in 1 file)")),
            "{found:?}"
        );
    }

    #[test]
    fn a_folder_whose_callers_use_nearly_all_its_functions_is_shallow() {
        let mut store = String::from("export type Store = { rows: number[] };\n");
        for i in 0..9 {
            store.push_str(&format!("export function op{i}(s: Store) {{ s.rows.push({i}); return s.rows.length; }}\n"));
        }
        let mut app =
            String::from("import { op0, op1, op2, op3, op4, op5, op6, op7, op8 } from '../store/ops';\nexport function main(s: any) {\n");
        for i in 0..9 {
            app.push_str(&format!("  op{i}(s);\n"));
        }
        app.push_str("}\n");
        let files = [("store/ops.ts", store.as_str()), ("app/main.ts", app.as_str())];
        let found = run_on(&files, None);
        let shallow: Vec<&Finding> = found.iter().filter(|f| f.target.starts_with("shallow-module")).collect();
        assert_eq!(shallow.len(), 1, "{found:?}");
        assert_eq!(shallow[0].target, "shallow-module store Store");
        assert!(shallow[0].message.starts_with("app/main.ts:3 main (app/main.ts) calls 9 of store's functions on Store (op0, op1, op2 and 6 more), and code outside store calls 9 of its 9"), "{}", shallow[0].message);
        // A change that adds none of them shows nothing new.
        assert!(run_on(&files, Some(vec![("app/main.ts", vec![])])).is_empty());
    }
}
