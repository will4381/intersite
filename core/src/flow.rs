//! Flows (CONTRACT.md "Flows") and the `ui` replay mode: plays browser tests in one shared Chrome, each in its own
//! browser context, over the DevTools protocol (cdp.rs). `intersite-core flow` reads the options from the first stdin
//! line and prints `{"ready": true}` once the browser is up. Each later `{"run": i, "flow": {...}}` line is a job; one
//! without `prepared` makes it print `{"prepare": i}` and wait for Node's `{"prepared": i, ...}` (the adapter's
//! reset, sign-in and IDs are the project's JavaScript). It prints `{"index": i, "steps": [...]}` as each job ends,
//! and exits once stdin closes and the jobs are done.

use crate::cdp::{self, Cdp};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const FIND_CAP: Duration = Duration::from_millis(1000);
const CLICK_CAP: Duration = Duration::from_millis(5000);
const SEE_CAP: Duration = Duration::from_millis(5000);
/// Slow emulated connections stretch page loads well past a second or two.
const LOAD_CAP: Duration = Duration::from_secs(30);
const SETTLE_CAP: Duration = Duration::from_millis(3000);
const QUIET: Duration = Duration::from_millis(300);
const POLL: Duration = Duration::from_millis(50);
const WRITES: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];
/// A 1x1 transparent GIF stands in for every image, so an image-only link or button keeps a box to click.
const PIXEL: &str = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/// Finds a click target in the page: inside the named element, its nth list item, then the element with that role and
/// label (`_` matches one word), or with `submit` the submit button of the named element's form. Role and name are
/// read as track/index.mjs records them, so the two always agree. With `act`, also scrolls it into view and says
/// whether a click there would land on it.
const FIND: &str = r#"(target, act) => {
  const ITEM = "li, tr, [role=listitem], [role=row], [role=option]";
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === "A") return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag !== "INPUT") return tag === "TEXTAREA" ? "textbox" : "generic";
    return ["submit", "button", "reset", "image"].includes(el.type) ? "button" : ["checkbox", "radio"].includes(el.type) ? el.type : "textbox";
  };
  const nameOf = (el) => (el.getAttribute("aria-label") || (el.tagName === "INPUT" ? el.value : el.textContent) || "").trim().split(/\s+/);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  let el = target.in ? document.querySelector(`[data-intersite="${CSS.escape(target.in)}"]`) : document.documentElement;
  if (el && target.nth !== undefined) el = el.querySelectorAll(ITEM)[target.nth];
  if (el && target.submit) el = el.closest("form")?.querySelector("button:not([type]), button[type=submit], input[type=submit], input[type=image]");
  if (el && target.role) {
    const words = target.label ? target.label.split(" ") : [];
    const matches = (got) => words.every((word, i) => got[i] !== undefined && (word === "_" || got[i] === word));
    const rank = (c) => (visible(c) ? 0 : 2) + (!words.length || nameOf(c).length === words.length ? 0 : 1);
    const found = [...el.querySelectorAll("*")].filter((c) => roleOf(c) === target.role && matches(nameOf(c)));
    el = found.sort((a, b) => rank(a) - rank(b))[0];
  }
  if (!el) return { found: false };
  if (!act) return { found: true };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  if (!visible(el)) return { found: true, why: "it is hidden" };
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return { found: true, why: "it is disabled" };
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (hit && hit !== el && !el.contains(hit)) return { found: true, why: `<${hit.tagName.toLowerCase()}> covers it` };
  return { found: true, ok: true, x, y, box: [r.left, r.top, r.width, r.height].map(Math.round).join() };
}"#;

/// Sets a form control by `name` or `id` as a user would leave it, firing input and change. The native setter, so a
/// framework that tracks the value (React) sees the change. With `within`, only in that named element's form.
const FILL: &str = r#"(field, value, within) => {
  const q = CSS.escape(field);
  const root = within ? document.querySelector(`[data-intersite="${CSS.escape(within)}"]`).closest("form") : document;
  const el = root.querySelector(`[name="${q}"], [id="${q}"]`);
  if (!el) return "missing";
  const kind = el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase();
  const text = value === null || value === undefined ? "" : String(value);
  const fire = (t) => { t.dispatchEvent(new Event("input", { bubbles: true })); t.dispatchEvent(new Event("change", { bubbles: true })); };
  const set = (t, v) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), "value").set.call(t, v);
  if (kind === "radio") {
    const option = typeof value === "boolean" ? el : root.querySelector(`input[type=radio][name="${q}"][value="${CSS.escape(text)}"]`);
    if (!option) return "no-option";
    if (value !== false && !option.checked) option.click();
    return "ok";
  }
  if (kind === "checkbox") {
    const on = typeof value === "boolean" ? value : text === el.value;
    if (el.checked !== on) el.click();
    return "ok";
  }
  if (kind === "select") {
    const option = [...el.options].find((o) => o.value === text || o.label === text);
    if (!option) return "no-option";
    set(el, option.value);
    fire(el);
    return "ok";
  }
  if (kind !== "hidden") el.focus();
  set(el, text);
  fire(el);
  return "ok";
}"#;

/// How a `ui` action's form takes its recorded body: "presence" when it cannot (the body is not a JSON object, or a
/// top-level key names no control in the element's closest form, or a radio has no such option), else how to submit
/// it: "self" (the element is the submit button, or there is no form), "button" (the form's), or "request".
const FORM: &str = r#"(name, body) => {
  const el = document.querySelector(`[data-intersite="${CSS.escape(name)}"]`);
  const form = el.closest("form");
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) return "presence";
  for (const [key, value] of Object.entries(body ?? {})) {
    const q = CSS.escape(key);
    const control = form && form.querySelector(`[name="${q}"], [id="${q}"]`);
    if (!control) return "presence";
    if (value !== null && typeof value === "object") continue;
    const option = `input[type=radio][name="${q}"][value="${CSS.escape(String(value ?? ""))}"]`;
    if (control.type === "radio" && typeof value !== "boolean" && !form.querySelector(option)) return "presence";
  }
  if (el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && ["submit", "image"].includes(el.type)) || !form) return "self";
  return form.querySelector("button:not([type]), button[type=submit], input[type=submit], input[type=image]") ? "button" : "request";
}"#;

const SUBMIT: &str = r#"(name) => document.querySelector(`[data-intersite="${CSS.escape(name)}"]`).closest("form").requestSubmit()"#;

const SEE: &str = r#"(text) => !!document.body && document.body.innerText.replace(/\s+/g, " ").toLowerCase().includes(text.replace(/\s+/g, " ").toLowerCase())"#;

#[derive(Deserialize)]
struct Input {
    options: Options,
}

/// One `{"run": i, "flow": {...}}` line: a flow file's steps, or a `ui` session's actions, with its sign-in when
/// Node already has it.
#[derive(Deserialize)]
struct Job {
    run: usize,
    flow: Flow,
    prepared: Option<Prepared>,
}

#[derive(Deserialize)]
struct Flow {
    #[serde(default)]
    env: Option<Env>,
    #[serde(default)]
    steps: Vec<Step>,
    /// A `ui` replay session: each action is played whatever the one before it did.
    #[serde(default)]
    actions: Vec<Action>,
}

/// One named action of a `ui` session, built by replay/ui.mjs.
#[derive(Deserialize)]
struct Action {
    /// The `data-intersite` name, or "UI" for a page view.
    name: String,
    page: String,
    /// Every case of the action only reads: it is clicked.
    #[serde(default)]
    reads: bool,
    /// Its one write, filled and submitted from the recorded body.
    write: Option<WriteCase>,
}

#[derive(Deserialize)]
struct WriteCase {
    /// Why its body cannot be rebuilt (an ID `resolveId` had no answer for).
    skip: Option<String>,
    #[serde(default)]
    expect: String,
    /// IDs already resolved and dates shifted; IDs the session creates are swapped here as they are learned.
    #[serde(default)]
    body: Value,
    #[serde(default)]
    ids: HashMap<String, String>,
}

#[derive(Deserialize, Default)]
struct Env {
    rtt: Option<f64>,
    down: Option<f64>,
    cpu: Option<f64>,
    viewport: Option<[u32; 2]>,
    mobile: Option<bool>,
}

/// One step, already checked by `flowProblem` in replay/flow.mjs: exactly one verb.
#[derive(Deserialize)]
struct Step {
    open: Option<String>,
    reload: Option<bool>,
    click: Option<Value>,
    fill: Option<Map<String, Value>>,
    see: Option<String>,
    at: Option<u64>,
    expect: Option<String>,
    ids: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    ui_target: String,
    target: String,
    headed: bool,
    browser: String,
    browser_url: String,
    network: String,
    timing: String,
    concurrency: usize,
}

/// What Node gives a flow before it starts: the adapter's sign-in, and the IDs its pages name, resolved.
#[derive(Deserialize, Default)]
struct Prepared {
    #[serde(default)]
    cookies: Vec<Cookie>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    ids: HashMap<String, String>,
    /// IDs `resolveId` had no answer for, with why: a page naming one is skipped.
    #[serde(default)]
    unresolved: HashMap<String, String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Cookie {
    name: String,
    value: String,
}

/// One line to Node. Lines from worker threads never interleave: each holds the lock for its whole line.
fn emit(line: &Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").ok();
    out.flush().ok();
}

/// Runs the jobs Node sends, `concurrency` at a time, each answered on stdout as it ends.
pub fn serve() -> Result<(), String> {
    let mut stdin = BufReader::new(std::io::stdin());
    let mut first = String::new();
    stdin.read_line(&mut first).map_err(|error| format!("cannot read the options: {error}"))?;
    let input: Input = serde_json::from_str(&first).map_err(|error| format!("the options are not valid JSON: {error}"))?;
    let options = &input.options;
    let browser = cdp::start(&options.browser, &options.browser_url, options.headed)?;
    let cdp = Cdp::connect(&browser.url)?;
    emit(&json!({ "ready": true }));
    let replies: Arc<Mutex<HashMap<usize, Sender<Prepared>>>> = Arc::default();
    let routes = replies.clone();
    let (jobs, queue) = channel::<Job>();
    // Its sender is dropped when stdin closes, which ends the workers once the queue is empty.
    std::thread::spawn(move || {
        for line in stdin.lines().map_while(Result::ok) {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(index) = message["prepared"].as_u64() {
                let prepared = serde_json::from_value(message).unwrap_or_default();
                if let Some(flow) = routes.lock().expect("replies lock").remove(&(index as usize)) {
                    flow.send(prepared).ok();
                }
            } else if let Ok(job) = serde_json::from_value::<Job>(message) {
                jobs.send(job).ok();
            }
        }
    });
    let queue = Mutex::new(queue);
    std::thread::scope(|scope| {
        for _ in 0..options.concurrency.max(1) {
            scope.spawn(|| {
                loop {
                    // Its own statement, so the lock is let go before the job runs.
                    let next = queue.lock().expect("queue lock").recv();
                    let Ok(job) = next else { break };
                    let prepared = match job.prepared {
                        Some(prepared) => Ok(prepared),
                        None => prepare(job.run, &replies),
                    };
                    let steps = prepared
                        .and_then(|prepared| run_flow(&cdp, options, &job.flow, &prepared))
                        .unwrap_or_else(|reason| vec![step_result(0, "start", Some(reason))]);
                    emit(&json!({ "index": job.run, "steps": steps }));
                }
            });
        }
    });
    drop(browser);
    Ok(())
}

/// Asks Node to reset, sign in and resolve IDs for one flow, and waits for the answer.
fn prepare(index: usize, replies: &Mutex<HashMap<usize, Sender<Prepared>>>) -> Result<Prepared, String> {
    let (tx, rx) = channel();
    replies.lock().expect("replies lock").insert(index, tx);
    emit(&json!({ "prepare": index }));
    let prepared = rx.recv_timeout(Duration::from_secs(120)).map_err(|_| "the adapter gave no sign-in within 120 s".to_string())?;
    match prepared.error {
        Some(error) => Err(error),
        None => Ok(prepared),
    }
}

fn step_result(index: usize, verb: &str, reason: Option<String>) -> Value {
    match reason {
        Some(reason) => json!({ "index": index, "verb": verb, "result": "failed", "reason": reason }),
        None => json!({ "index": index, "verb": verb, "result": "passed" }),
    }
}

/// What one page has done so far, kept by its event thread.
#[derive(Default)]
struct State {
    frame: String,
    url: String,
    navs: u64,
    loads: u64,
    loading: bool,
    /// Requests of the current document not yet finished.
    pending: HashSet<String>,
    last: Option<Instant>,
    problems: Vec<String>,
    /// Request ID -> method and URL.
    requests: HashMap<String, (String, String)>,
    /// Method and path of every request, in the order sent.
    sent: Vec<(String, String)>,
    answers: Vec<Answer>,
    /// Write answers' bodies, read before the page got them: a page that navigates afterwards takes them with it.
    bodies: HashMap<String, String>,
}

struct Answer {
    id: String,
    method: String,
    path: String,
    status: u64,
}

/// One flow's page: a session on the shared connection, and the state its events keep.
struct Page {
    cdp: Arc<Cdp>,
    session: String,
    shared: Arc<(Mutex<State>, Condvar)>,
}

impl Page {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.cdp.call(Some(&self.session), method, params)
    }

    /// `function(args...)` run in the page, its value returned. Fails while a navigation replaces the document.
    fn run(&self, function: &str, args: &[Value]) -> Result<Value, String> {
        let list = args.iter().map(Value::to_string).collect::<Vec<_>>().join(", ");
        let answer = self.call(
            "Runtime.evaluate",
            json!({ "expression": format!("({function})({list})"), "returnByValue": true, "awaitPromise": true }),
        )?;
        if let Some(details) = answer.get("exceptionDetails") {
            return Err(details["exception"]["description"].as_str().or(details["text"].as_str()).unwrap_or("failed").to_string());
        }
        Ok(answer["result"]["value"].clone())
    }

    /// Calls `function` until `done` accepts its value or `cap` passes; the last value either way.
    fn poll(&self, cap: Duration, function: &str, args: &[Value], done: impl Fn(&Value) -> bool) -> (bool, Value) {
        let end = Instant::now() + cap;
        let mut last = Value::Null;
        loop {
            // An error here is a document being replaced by navigation: the next try reads the new one.
            if let Ok(value) = self.run(function, args) {
                if done(&value) {
                    return (true, value);
                }
                last = value;
            }
            if Instant::now() >= end {
                return (false, last);
            }
            std::thread::sleep(POLL);
        }
    }

    fn with<T>(&self, read: impl FnOnce(&mut State) -> T) -> T {
        read(&mut self.shared.0.lock().expect("state lock"))
    }

    /// Waits until `done` holds or `cap` passes, rechecking on every event and every 50 ms (for conditions on time).
    fn wait(&self, cap: Duration, done: impl Fn(&State) -> bool) -> bool {
        let (lock, changed) = &*self.shared;
        let end = Instant::now() + cap;
        let mut state = lock.lock().expect("state lock");
        loop {
            if done(&state) {
                return true;
            }
            let now = Instant::now();
            if now >= end {
                return false;
            }
            state = changed.wait_timeout(state, (end - now).min(POLL)).expect("state lock").0;
        }
    }

    fn path(&self) -> String {
        self.with(|state| path_of(&state.url).to_string())
    }

    fn problem(&self) -> Option<String> {
        self.with(|state| state.problems.first().cloned())
    }
}

/// A base64 body as text; one that is not UTF-8 (binary) as empty, since it holds no IDs to learn.
fn decode(body: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(body).ok().and_then(|bytes| String::from_utf8(bytes).ok()).unwrap_or_default()
}

/// `scheme://host:port` of a URL.
fn origin_of(url: &str) -> &str {
    let start = url.find("://").map_or(0, |i| i + 3);
    url[start..].find('/').map_or(url, |i| &url[..start + i])
}

/// The path of a URL, without its query or fragment.
fn path_of(url: &str) -> &str {
    let rest = &url[origin_of(url).len()..];
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    if end == 0 {
        "/"
    } else {
        &rest[..end]
    }
}

/// Everything after the origin up to the query: the page a URL shows.
fn page_of(url: &str) -> &str {
    &url[..url.find(['?', '#']).unwrap_or(url.len())]
}

/// What the page's events say, kept in `State`; requests are routed (sign-in headers to the app and the API only,
/// images, fonts and media answered here) and each write's answer read before the page gets it.
struct Watch {
    cdp: Arc<Cdp>,
    session: String,
    shared: Arc<(Mutex<State>, Condvar)>,
    origins: Vec<String>,
    headers: HashMap<String, String>,
    lag: Duration,
}

impl Watch {
    fn run(self, events: Receiver<Value>) {
        for event in events {
            let params = &event["params"];
            match event["method"].as_str().unwrap_or("") {
                "Fetch.requestPaused" => self.route(params),
                method => {
                    let (lock, changed) = &*self.shared;
                    note(&mut lock.lock().expect("state lock"), method, params, &self.origins);
                    changed.notify_all();
                }
            }
        }
    }

    fn route(&self, params: &Value) {
        let id = params["requestId"].clone();
        let call = |method: &str, args: Value| {
            // A request the page already dropped (it navigated away) has nothing left to route.
            self.cdp.call(Some(&self.session), method, args).ok();
        };
        if params.get("responseStatusCode").is_some() || params.get("responseErrorReason").is_some() {
            let (cdp, session, shared, lag) = (self.cdp.clone(), self.session.clone(), self.shared.clone(), self.lag);
            let network = params["networkId"].as_str().unwrap_or("").to_string();
            // Its own thread, so a write's lag holds back only that answer, not the page's other requests.
            std::thread::spawn(move || {
                if let Ok(body) = cdp.call(Some(&session), "Fetch.getResponseBody", json!({ "requestId": id })) {
                    let text = body["body"].as_str().unwrap_or("");
                    // Chrome hands an intercepted body over base64-encoded, whatever its type.
                    let text = if body["base64Encoded"] == true { decode(text) } else { text.to_string() };
                    shared.0.lock().expect("state lock").bodies.insert(network, text);
                }
                std::thread::sleep(lag);
                cdp.call(Some(&session), "Fetch.continueResponse", json!({ "requestId": id })).ok();
            });
            return;
        }
        let request = &params["request"];
        let url = request["url"].as_str().unwrap_or("");
        match params["resourceType"].as_str().unwrap_or("") {
            "Image" => call(
                "Fetch.fulfillRequest",
                json!({ "requestId": id, "responseCode": 200, "responseHeaders": [{ "name": "content-type", "value": "image/gif" }], "body": PIXEL }),
            ),
            // An empty answer, not an abort: Chrome logs an aborted request as a console error, which would fail the step.
            "Font" | "Media" => call("Fetch.fulfillRequest", json!({ "requestId": id, "responseCode": 200, "body": "" })),
            _ if self.origins.iter().any(|origin| origin == origin_of(url)) => {
                let mut headers: Vec<Value> = request["headers"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(name, _)| !self.headers.contains_key(&name.to_lowercase()))
                    .map(|(name, value)| json!({ "name": name, "value": value }))
                    .collect();
                headers.extend(self.headers.iter().map(|(name, value)| json!({ "name": name, "value": value })));
                let write = WRITES.contains(&request["method"].as_str().unwrap_or(""));
                call("Fetch.continueRequest", json!({ "requestId": id, "headers": headers, "interceptResponse": write }));
            }
            _ => call("Fetch.continueRequest", json!({ "requestId": id })),
        }
    }
}

/// Keeps one event in the page's state.
fn note(state: &mut State, method: &str, params: &Value, origins: &[String]) {
    let text = |value: &Value| value.as_str().unwrap_or("").to_string();
    match method {
        "Network.requestWillBeSent" => {
            state.pending.insert(text(&params["requestId"]));
            state.last = Some(Instant::now());
            let (method, url) = (text(&params["request"]["method"]), text(&params["request"]["url"]));
            state.sent.push((method.clone(), path_of(&url).to_string()));
            state.requests.insert(text(&params["requestId"]), (method, url));
        }
        "Network.responseReceived" => {
            let id = text(&params["requestId"]);
            let (method, url) = state.requests.get(&id).cloned().unwrap_or_default();
            let status = params["response"]["status"].as_u64().unwrap_or(0);
            if status >= 500 && origins.iter().any(|origin| origin == origin_of(&url)) {
                state.problems.push(format!("{status} from {method} {}", path_of(&url)));
            }
            state.answers.push(Answer { id, method, path: path_of(&url).to_string(), status });
        }
        "Network.loadingFinished" | "Network.loadingFailed" => {
            state.pending.remove(params["requestId"].as_str().unwrap_or(""));
            state.last = Some(Instant::now());
        }
        "Runtime.exceptionThrown" => {
            let details = &params["exceptionDetails"];
            let message = details["exception"]["description"].as_str().or(details["text"].as_str()).unwrap_or("error");
            state.problems.push(format!("page error: {}", message.lines().next().unwrap_or("")));
        }
        "Runtime.consoleAPICalled" if params["type"] == "error" => {
            let args = params["args"].as_array().into_iter().flatten();
            let words: Vec<String> =
                args.map(|arg| arg["value"].as_str().map(String::from).unwrap_or_else(|| text(&arg["description"]))).collect();
            state.problems.push(format!("console error: {}", words.join(" ")));
        }
        "Log.entryAdded" if params["entry"]["level"] == "error" => {
            state.problems.push(format!("console error: {}", text(&params["entry"]["text"])))
        }
        "Page.frameNavigated" if params["frame"].get("parentId").is_none() => {
            state.frame = text(&params["frame"]["id"]);
            state.url = text(&params["frame"]["url"]);
            state.navs += 1;
            // The old document's requests (a beacon sent as it unloaded) are never reported finished.
            let document = text(&params["frame"]["loaderId"]);
            state.pending.retain(|id| *id == document);
        }
        "Page.navigatedWithinDocument" if params["frameId"] == state.frame.as_str() => state.url = text(&params["url"]),
        "Page.loadEventFired" => state.loads += 1,
        "Page.frameStartedLoading" if params["frameId"] == state.frame.as_str() => state.loading = true,
        "Page.frameStoppedLoading" if params["frameId"] == state.frame.as_str() => state.loading = false,
        _ => {}
    }
}

/// Opens a context with the flow's sign-in, device and connection, plays its steps, and closes it.
fn run_flow(cdp: &Arc<Cdp>, options: &Options, flow: &Flow, prepared: &Prepared) -> Result<Vec<Value>, String> {
    let base = options.ui_target.trim_end_matches('/').to_string();
    let origins = vec![origin_of(&base).to_string(), origin_of(&options.target).to_string()];
    let context = cdp.call(None, "Target.createBrowserContext", json!({ "disposeOnDetach": true }))?["browserContextId"].clone();
    let played = (|| {
        if !prepared.cookies.is_empty() {
            let cookies: Vec<Value> = prepared
                .cookies
                .iter()
                .flat_map(|c| origins.iter().map(|url| json!({ "name": c.name, "value": c.value, "url": url })))
                .collect();
            cdp.call(None, "Storage.setCookies", json!({ "cookies": cookies, "browserContextId": context }))?;
        }
        let target =
            cdp.call(None, "Target.createTarget", json!({ "url": "about:blank", "browserContextId": context }))?["targetId"].clone();
        let session = cdp.call(None, "Target.attachToTarget", json!({ "targetId": target, "flatten": true }))?["sessionId"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let env = if options.network == "recorded" { flow.env.as_ref() } else { None };
        let page = Page { cdp: cdp.clone(), session: session.clone(), shared: Arc::default() };
        let watch = Watch {
            cdp: cdp.clone(),
            session: session.clone(),
            shared: page.shared.clone(),
            origins: origins.clone(),
            headers: prepared.headers.iter().map(|(name, value)| (name.to_lowercase(), value.clone())).collect(),
            lag: Duration::from_millis(env.and_then(|e| e.rtt).unwrap_or(0.0) as u64),
        };
        let events = cdp.events(&session);
        std::thread::spawn(move || watch.run(events));
        let mut run = Run {
            page: &page,
            prepared,
            base: &base,
            fast: options.timing == "fast",
            learned: HashMap::new(),
            page_at: Instant::now(),
            clicked: false,
        };
        let result = set_up(&page, env).map(|()| if flow.actions.is_empty() { play(flow, &mut run) } else { play_actions(flow, &mut run) });
        cdp.forget(&session);
        result
    })();
    cdp.call(None, "Target.disposeBrowserContext", json!({ "browserContextId": context })).ok();
    played
}

/// Turns on the events a flow reads, request routing, and the recorded device and connection.
fn set_up(page: &Page, env: Option<&Env>) -> Result<(), String> {
    for domain in ["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"] {
        page.call(domain, json!({}))?;
    }
    page.call("Fetch.enable", json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] }))?;
    let frame = page.call("Page.getFrameTree", json!({}))?["frameTree"]["frame"]["id"].as_str().unwrap_or("").to_string();
    page.with(|state| state.frame = frame);
    let [width, height] = env.and_then(|e| e.viewport).unwrap_or([1280, 720]);
    let mobile = env.and_then(|e| e.mobile).unwrap_or(false);
    page.call("Emulation.setDeviceMetricsOverride", json!({ "width": width, "height": height, "deviceScaleFactor": 1, "mobile": mobile }))?;
    let Some(env) = env else { return Ok(()) };
    let emulate = || -> Result<(), String> {
        if mobile {
            page.call("Emulation.setTouchEmulationEnabled", json!({ "enabled": true, "maxTouchPoints": 5 }))?;
        }
        if env.rtt.is_some() || env.down.is_some() {
            // ponytail: upload is taken as a quarter of download, as on most mobile and home links; record it if uploads matter.
            let rate = env.down.map_or(-1.0, |mbps| mbps * 125_000.0);
            let upload = if rate > 0.0 { rate / 4.0 } else { -1.0 };
            page.call(
                "Network.emulateNetworkConditions",
                json!({ "offline": false, "latency": env.rtt.unwrap_or(0.0), "downloadThroughput": rate, "uploadThroughput": upload }),
            )?;
        }
        if let Some(cpu) = env.cpu.filter(|&rate| rate > 1.0) {
            page.call("Emulation.setCPUThrottlingRate", json!({ "rate": cpu }))?;
        }
        Ok(())
    };
    emulate().map_err(|error| format!("this browser cannot emulate the recorded connection ({error}); run with --network none"))
}

/// What the steps share as they run.
struct Run<'a> {
    page: &'a Page,
    prepared: &'a Prepared,
    base: &'a str,
    fast: bool,
    /// Recorded ID -> the one this run's answers created.
    learned: HashMap<String, String>,
    page_at: Instant,
    clicked: bool,
}

/// Plays the steps until one fails or is skipped; a problem that surfaces after the last step counts against it.
fn play(flow: &Flow, run: &mut Run) -> Vec<Value> {
    let mut results = Vec::new();
    for (index, step) in flow.steps.iter().enumerate() {
        let verb = verb_of(step);
        match run_step(step, run) {
            Err(skip) => {
                results.push(json!({ "index": index, "verb": verb, "result": "skipped", "reason": skip }));
                return results;
            }
            Ok(reason) => {
                let failed = reason.is_some();
                results.push(step_result(index, verb, reason));
                if failed {
                    return results;
                }
            }
        }
    }
    settle(run.page);
    if let (Some(late), Some(last)) = (run.page.problem(), results.last_mut()) {
        last["result"] = json!("failed");
        last["reason"] = json!(late);
    }
    results
}

/// Waits until no request is in flight and none started or ended for a moment, at most `SETTLE_CAP`. The moment
/// counts from now too: a click's handler may send its request a little after the click.
fn settle(page: &Page) {
    let from = Instant::now();
    page.wait(SETTLE_CAP, |state| state.pending.is_empty() && state.last.map_or(from, |last| last.max(from)).elapsed() >= QUIET);
}

fn verb_of(step: &Step) -> &'static str {
    match () {
        () if step.open.is_some() => "open",
        () if step.reload.is_some() => "reload",
        () if step.click.is_some() => "click",
        () if step.fill.is_some() => "fill",
        _ => "see",
    }
}

/// One step: `Ok(None)` passed, `Ok(Some(reason))` failed, `Err(reason)` skipped (a page's ID could not be resolved).
/// Problems are never cleared: one a step causes may surface during the next, and the flow stops at the first anyway.
fn run_step(step: &Step, run: &mut Run) -> Result<Option<String>, String> {
    let clicked = std::mem::replace(&mut run.clicked, step.click.is_some());
    let failure = if let Some(path) = &step.open {
        open(path, clicked, run)?
    } else if step.reload.is_some() {
        reload(run)
    } else if let Some(target) = &step.click {
        click_step(target, step, run)
    } else if let Some(fields) = &step.fill {
        fill(fields, step, run)
    } else {
        see(step.see.as_deref().unwrap_or(""), run.page)
    };
    Ok(failure.or_else(|| run.page.problem()))
}

/// A page path with recorded IDs swapped for this run's: created earlier in the flow, or resolved by the adapter.
fn remap(path: &str, run: &Run) -> Result<String, String> {
    if path.split('/').any(|segment| segment == "_") {
        return Err(format!("page {path} has a segment capture reduced to _, which cannot be resolved"));
    }
    let mut segments = Vec::new();
    for segment in path.split('/') {
        if let Some(reason) = run.prepared.unresolved.get(segment).filter(|_| !run.learned.contains_key(segment)) {
            return Err(reason.clone());
        }
        segments.push(run.learned.get(segment).or(run.prepared.ids.get(segment)).map_or(segment, String::as_str));
    }
    Ok(segments.join("/"))
}

/// Waits until a navigation finished: loaded under fast timing, committed under recorded timing (as a user acts).
fn landed(run: &Run, navs: u64, loads: u64) -> bool {
    if run.fast {
        run.page.wait(LOAD_CAP, |state| state.loads > loads && !state.loading)
    } else {
        run.page.wait(LOAD_CAP, |state| state.navs > navs)
    }
}

/// Goes to a page, unless a click just took the app there: opening it again would lose its state.
fn open(path: &str, clicked: bool, run: &mut Run) -> Result<Option<String>, String> {
    let url = format!("{}{}", run.base, remap(path, run)?);
    let there = |state: &State| page_of(&state.url) == url;
    if clicked {
        run.page.wait(FIND_CAP, there);
    }
    let failure = if run.page.with(|state| there(state)) {
        if run.fast {
            run.page.wait(LOAD_CAP, |state| !state.loading);
        }
        None
    } else {
        return Ok(goto(&url, path, run));
    };
    run.page_at = Instant::now();
    Ok(failure)
}

/// Loads `url`, even when the page is already there; `path` names it in a failure.
fn goto(url: &str, path: &str, run: &mut Run) -> Option<String> {
    let (navs, loads) = run.page.with(|state| (state.navs, state.loads));
    let failure = match run.page.call("Page.navigate", json!({ "url": url })) {
        Ok(answer) if answer["errorText"].as_str().is_some_and(|text| !text.is_empty()) => {
            Some(format!("cannot open {path}: {}", answer["errorText"]))
        }
        Ok(_) if !landed(run, navs, loads) => Some(format!("{path} did not load within {} s", LOAD_CAP.as_secs())),
        Ok(_) => None,
        Err(error) => Some(error),
    };
    run.page_at = Instant::now();
    failure
}

fn reload(run: &mut Run) -> Option<String> {
    let (navs, loads) = run.page.with(|state| (state.navs, state.loads));
    let failure = match run.page.call("Page.reload", json!({})) {
        Ok(_) if !landed(run, navs, loads) => Some(format!("the reload did not finish within {} s", LOAD_CAP.as_secs())),
        Ok(_) => None,
        Err(error) => Some(error),
    };
    run.page_at = Instant::now();
    failure
}

/// Waits until the recorded moment after the page loaded, under recorded timing.
fn wait_for_moment(at: Option<u64>, run: &Run) {
    if let (false, Some(at)) = (run.fast, at) {
        let moment = run.page_at + Duration::from_millis(at);
        if let Some(wait) = moment.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
    }
}

/// A flow's click; with `expect`, checks the answer.
fn click_step(target: &Value, step: &Step, run: &mut Run) -> Option<String> {
    match click(target, step.at, run) {
        Err(failure) => Some(failure),
        Ok(since) => step.expect.as_deref().and_then(|expect| expectation(expect, step.ids.as_ref(), since, LOAD_CAP, run)),
    }
}

/// How many answers and requests the page had: what came after is what an action caused.
type Since = (usize, usize);

fn since(page: &Page) -> Since {
    page.with(|state| (state.answers.len(), state.sent.len()))
}

/// Clicks the target once it is there, visible, enabled, still and not covered (at `at` under recorded timing).
fn click(target: &Value, at: Option<u64>, run: &Run) -> Result<Since, String> {
    let page = run.page;
    let target_json = if target.is_string() { json!({ "in": target }) } else { target.clone() };
    let (found, _) =
        page.poll(if run.fast { FIND_CAP } else { LOAD_CAP }, FIND, &[target_json.clone(), json!(false)], |value| value["found"] == true);
    if !found {
        return Err(format!("{target} not found on {}", page.path()));
    }
    wait_for_moment(at, run);
    let previous = Mutex::new(String::new());
    // Ready when it can take the click and has not moved since the last look (an animation would make it miss).
    let ready = |value: &Value| {
        let box_now = value["box"].as_str().unwrap_or("").to_string();
        let still = value["ok"] == true && *previous.lock().expect("box lock") == box_now;
        *previous.lock().expect("box lock") = box_now;
        still
    };
    let (ok, last) = page.poll(CLICK_CAP, FIND, &[target_json, json!(true)], ready);
    if !ok {
        let why = last["why"].as_str().unwrap_or("it kept moving");
        return Err(format!("{target} could not be clicked on {}: {why}", page.path()));
    }
    let (x, y) = (last["x"].as_f64().unwrap_or(0.0), last["y"].as_f64().unwrap_or(0.0));
    let before = since(page);
    for (kind, buttons) in [("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)] {
        let mut event = json!({ "type": kind, "x": x, "y": y });
        if kind != "mouseMoved" {
            event["button"] = json!("left");
            event["buttons"] = json!(buttons);
            event["clickCount"] = json!(1);
        }
        page.call("Input.dispatchMouseEvent", event)?;
    }
    Ok(before)
}

/// A route template as a path pattern: `:name` stands for one segment, and the path may carry a prefix (the web
/// app's `/api` in front of the server's routes).
fn route_pattern(route: &str) -> regex::Regex {
    let body: Vec<String> =
        route.split('/').map(|segment| if segment.starts_with(':') { "[^/]+".to_string() } else { regex::escape(segment) }).collect();
    regex::Regex::new(&format!("^(?:/.*)?{}$", body.join("/"))).expect("an escaped route is a valid pattern")
}

/// Whether the request an action caused was answered as recorded, waiting up to `cap` for the answer; learns the IDs
/// it created. A recorded server error passes once any answer below 500 comes back: the error was the bug.
fn expectation(expect: &str, ids: Option<&HashMap<String, String>>, since: Since, cap: Duration, run: &mut Run) -> Option<String> {
    let mut parts = expect.split(' ');
    let (method, route, want) =
        (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0));
    let pattern = route_pattern(route);
    let wanted = |m: &str, path: &str| m == method && pattern.is_match(path);
    let matching = |state: &State| state.answers[since.0.min(state.answers.len())..].iter().position(|a| wanted(&a.method, &a.path));
    if !run.page.wait(cap, |state| matching(state).is_some()) {
        let sent = run.page.with(|state| state.sent[since.1.min(state.sent.len())..].iter().any(|(m, path)| wanted(m, path)));
        return Some(if sent { format!("{method} {route} got no answer") } else { format!("no {method} {route} request was sent") });
    }
    let (status, body) = run.page.with(|state| {
        let answer = &state.answers[since.0 + matching(state).expect("waited for it")];
        (answer.status, state.bodies.get(&answer.id).cloned())
    });
    if status != want && !(want >= 500 && status < 500) {
        return Some(format!("status {status}, expected {want} for {method} {route}"));
    }
    // Chrome logs every 4xx answer as a console error; this one was expected, so its log is too.
    let expected = format!("console error: Failed to load resource: the server responded with a status of {status} ");
    run.page.with(|state| state.problems.retain(|problem| !problem.starts_with(&expected)));
    let json: Value = body.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null);
    for (pointer, recorded) in ids.into_iter().flatten() {
        if let Some(created) = json.pointer(pointer).and_then(Value::as_str) {
            run.learned.insert(recorded.clone(), created.to_string());
        }
    }
    None
}

fn fill(fields: &Map<String, Value>, step: &Step, run: &Run) -> Option<String> {
    wait_for_moment(step.at, run);
    fill_in(fields, Value::Null, run)
}

/// Sets each named control (in the `within` element's form, when named); nested values are left as the page has them.
fn fill_in(fields: &Map<String, Value>, within: Value, run: &Run) -> Option<String> {
    for (field, value) in fields.iter().filter(|(_, value)| !value.is_object() && !value.is_array()) {
        let (_, outcome) = run.page.poll(FIND_CAP, FILL, &[json!(field), value.clone(), within.clone()], |outcome| outcome != "missing");
        match outcome.as_str() {
            Some("ok") => {}
            Some("no-option") => return Some(format!("field {field} has no option {value}")),
            _ => return Some(format!("no field {field} on {}", run.page.path())),
        }
    }
    None
}

fn see(text: &str, page: &Page) -> Option<String> {
    let (seen, _) = page.poll(SEE_CAP, SEE, &[json!(text)], |value| value == true);
    (!seen).then(|| format!("{} is not on {}", json!(text), page.path()))
}

/// How one `ui` action ended.
enum Outcome {
    Passed,
    /// Its form could not be filled from the recorded body, so only its presence was checked.
    Presence,
    Failed(String),
    Skipped(String),
}

/// Plays every action of a `ui` session, each on a freshly loaded page, whatever the one before it did.
fn play_actions(flow: &Flow, run: &mut Run) -> Vec<Value> {
    let results = flow.actions.iter().enumerate().map(|(index, action)| match act(action, run) {
        Outcome::Passed => json!({ "index": index, "result": "passed" }),
        Outcome::Presence => json!({ "index": index, "result": "passed", "checked": "presence" }),
        Outcome::Failed(reason) => json!({ "index": index, "result": "failed", "reason": reason }),
        Outcome::Skipped(reason) => json!({ "index": index, "result": "skipped", "reason": reason }),
    });
    results.collect()
}

/// Opens the action's page and checks it loads cleanly; clicks a read, or fills and submits a write's form and checks
/// its answer (CONTRACT.md "Replay modes", `ui`).
fn act(action: &Action, run: &mut Run) -> Outcome {
    let (name, page) = (action.name.as_str(), action.page.as_str());
    let path = match remap(page, run) {
        Ok(path) => path,
        Err(skip) => return Outcome::Skipped(skip),
    };
    run.page.with(|state| state.problems.clear());
    if let Some(failure) = goto(&format!("{}{path}", run.base), page, run) {
        return Outcome::Failed(failure);
    }
    let failed = |run: &Run| {
        settle(run.page);
        run.page.problem()
    };
    if let Some(problem) = failed(run) {
        return Outcome::Failed(problem);
    }
    if name == "UI" {
        return Outcome::Passed;
    }
    let named = json!(name);
    let (found, _) = run.page.poll(FIND_CAP, FIND, &[json!({ "in": name }), json!(false)], |value| value["found"] == true);
    if !found {
        return Outcome::Failed(format!("action {name} not found on {page}"));
    }
    if action.reads {
        return match click(&named, None, run).err().or_else(|| failed(run)) {
            Some(failure) => Outcome::Failed(failure),
            None => Outcome::Passed,
        };
    }
    let look = run.page.run(FIND, &[json!({ "in": name }), json!(true)]).unwrap_or_default();
    if matches!(look["why"].as_str(), Some("it is hidden" | "it is disabled")) {
        return Outcome::Failed(format!("action {name} on {page} is hidden or disabled"));
    }
    let Some(write) = &action.write else { return Outcome::Presence };
    if let Some(skip) = &write.skip {
        return Outcome::Skipped(skip.clone());
    }
    let body = learned_ids(&write.body, &run.learned);
    let how = run.page.run(FORM, &[named.clone(), body.clone()]).unwrap_or_default();
    if how == "presence" || how.is_null() {
        return Outcome::Presence;
    }
    if let Some(failure) = body.as_object().and_then(|fields| fill_in(fields, named.clone(), run)) {
        return Outcome::Failed(failure);
    }
    let before = since(run.page);
    let submitted = match how.as_str() {
        Some("button") => click(&json!({ "in": name, "submit": true }), None, run).map(|_| ()),
        Some("request") => run.page.run(SUBMIT, std::slice::from_ref(&named)).map(|_| ()),
        _ => click(&named, None, run).map(|_| ()),
    };
    if let Err(failure) = submitted {
        return Outcome::Failed(failure);
    }
    settle(run.page);
    match expectation(&write.expect, Some(&write.ids), before, Duration::ZERO, run).or_else(|| run.page.problem()) {
        Some(failure) => Outcome::Failed(failure),
        None => Outcome::Passed,
    }
}

/// A recorded body with each ID an earlier action created swapped for the one this run got.
fn learned_ids(value: &Value, learned: &HashMap<String, String>) -> Value {
    match value {
        Value::String(id) => learned.get(id).map_or_else(|| value.clone(), |created| json!(created)),
        Value::Array(items) => items.iter().map(|item| learned_ids(item, learned)).collect(),
        Value::Object(fields) => fields.iter().map(|(key, item)| (key.clone(), learned_ids(item, learned))).collect(),
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_split_into_origin_path_and_page() {
        assert_eq!(origin_of("http://127.0.0.1:3000/ads/1?x=1"), "http://127.0.0.1:3000");
        assert_eq!(origin_of("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
        assert_eq!(path_of("http://a.test/ads/1?x=1#y"), "/ads/1");
        assert_eq!(path_of("http://a.test"), "/");
        assert_eq!(page_of("http://a.test/ads?x=1"), "http://a.test/ads");
    }

    #[test]
    fn a_route_matches_its_paths_under_any_prefix() {
        let route = route_pattern("/ads/:id");
        assert!(route.is_match("/ads/ad_1"));
        assert!(route.is_match("/api/ads/ad_1"));
        assert!(!route.is_match("/ads/ad_1/edit"));
        assert!(!route_pattern("/a.b").is_match("/aXb"));
    }
}
