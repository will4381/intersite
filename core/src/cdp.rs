//! A Chrome DevTools Protocol client for flows: starts (or connects to) the browser and speaks CDP over one
//! WebSocket, with no browser-automation library in between. Commands are synchronous calls that any thread may
//! make; events go to the session (page) they belong to.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long one command may take before its caller is told the browser stopped answering.
const ANSWER: Duration = Duration::from_secs(60);

/// The writing half of a client WebSocket: every frame masked, as RFC 6455 requires of a client.
struct Writer {
    stream: TcpStream,
    mask: u32,
}

impl Writer {
    fn send(&mut self, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
        let mut frame = vec![0x80 | opcode];
        let len = payload.len();
        if len < 126 {
            frame.push(0x80 | len as u8);
        } else if len <= u16::MAX as usize {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
        // A changing key, not a secret one: the mask guards proxies against cache poisoning, and there is no proxy here.
        self.mask = self.mask.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let key = self.mask.to_be_bytes();
        frame.extend_from_slice(&key);
        frame.extend(payload.iter().enumerate().map(|(i, byte)| byte ^ key[i % 4]));
        self.stream.write_all(&frame)
    }
}

/// Reads one whole message (joining continuation frames); answers pings. None when the connection closed.
fn read_message(reader: &mut impl Read, writer: &Mutex<Writer>) -> Option<Vec<u8>> {
    let mut message = Vec::new();
    loop {
        let mut head = [0u8; 2];
        reader.read_exact(&mut head).ok()?;
        let (fin, opcode, masked) = (head[0] & 0x80 != 0, head[0] & 0x0f, head[1] & 0x80 != 0);
        let len = match head[1] & 0x7f {
            126 => {
                let mut n = [0u8; 2];
                reader.read_exact(&mut n).ok()?;
                u16::from_be_bytes(n) as usize
            }
            127 => {
                let mut n = [0u8; 8];
                reader.read_exact(&mut n).ok()?;
                u64::from_be_bytes(n) as usize
            }
            n => n as usize,
        };
        let mut key = [0u8; 4];
        if masked {
            reader.read_exact(&mut key).ok()?;
        }
        let mut payload = vec![0u8; len];
        reader.read_exact(&mut payload).ok()?;
        if masked {
            payload.iter_mut().enumerate().for_each(|(i, byte)| *byte ^= key[i % 4]);
        }
        match opcode {
            0x8 => return None,
            0x9 => {
                writer.lock().ok()?.send(0xA, &payload).ok()?;
                continue;
            }
            0xA => continue,
            _ => message.extend_from_slice(&payload),
        }
        if fin {
            return Some(message);
        }
    }
}

/// Callers waiting for a command's answer, by command ID.
type Waiting = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// The browser end of the run: one connection, any number of page sessions on it.
pub struct Cdp {
    writer: Arc<Mutex<Writer>>,
    next: AtomicU64,
    waiting: Waiting,
    sessions: Arc<Mutex<HashMap<String, Sender<Value>>>>,
}

impl Cdp {
    /// Opens the WebSocket at `url` (`ws://host:port/path`) and starts the thread that routes what comes back.
    pub fn connect(url: &str) -> Result<Arc<Cdp>, String> {
        let rest = url.strip_prefix("ws://").ok_or_else(|| format!("{url} is not a ws:// URL"))?;
        let (host, path) = rest.split_once('/').map_or((rest, "/".to_string()), |(h, p)| (h, format!("/{p}")));
        let stream = TcpStream::connect(host).map_err(|error| format!("cannot connect to the browser at {url}: {error}"))?;
        stream.set_nodelay(true).ok();
        let mut handshake = stream.try_clone().map_err(|error| error.to_string())?;
        // The sample nonce from RFC 6455: the key proves nothing on a local connection, so any valid one will do.
        write!(
            handshake,
            "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        .map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
        let mut status = String::new();
        reader.read_line(&mut status).map_err(|error| error.to_string())?;
        if !status.contains(" 101 ") {
            return Err(format!("the browser at {url} refused the connection: {}", status.trim()));
        }
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).map_err(|error| error.to_string())? == 0 || line == "\r\n" {
                break;
            }
        }
        let cdp = Arc::new(Cdp {
            writer: Arc::new(Mutex::new(Writer { stream, mask: std::process::id() })),
            next: AtomicU64::new(1),
            waiting: Arc::default(),
            sessions: Arc::default(),
        });
        let (writer, waiting, sessions) = (cdp.writer.clone(), cdp.waiting.clone(), cdp.sessions.clone());
        std::thread::spawn(move || {
            while let Some(bytes) = read_message(&mut reader, &writer) {
                let Ok(message) = serde_json::from_slice::<Value>(&bytes) else { continue };
                if let Some(id) = message["id"].as_u64() {
                    let answer = match message.get("error") {
                        Some(error) => Err(error["message"].as_str().unwrap_or("failed").to_string()),
                        None => Ok(message["result"].clone()),
                    };
                    if let Some(caller) = waiting.lock().expect("waiting lock").remove(&id) {
                        caller.send(answer).ok();
                    }
                } else if let Some(session) = message["sessionId"].as_str() {
                    if let Some(page) = sessions.lock().expect("sessions lock").get(session) {
                        page.send(message).ok();
                    }
                }
            }
            // The browser is gone: every caller still waiting hears so instead of waiting out its timeout.
            waiting.lock().expect("waiting lock").clear();
        });
        Ok(cdp)
    }

    /// Sends one command, to the browser or to a page session, and waits for its result.
    pub fn call(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.waiting.lock().expect("waiting lock").insert(id, tx);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let text = message.to_string();
        self.writer
            .lock()
            .expect("writer lock")
            .send(0x1, text.as_bytes())
            .map_err(|error| format!("{method}: the browser is gone ({error})"))?;
        match rx.recv_timeout(ANSWER) {
            Ok(answer) => answer.map_err(|error| format!("{method}: {error}")),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                self.waiting.lock().expect("waiting lock").remove(&id);
                Err(format!("{method}: the browser gave no answer in {} s", ANSWER.as_secs()))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(format!("{method}: the browser is gone")),
        }
    }

    /// The events of one page session, from now on.
    pub fn events(&self, session: &str) -> Receiver<Value> {
        let (tx, rx) = channel();
        self.sessions.lock().expect("sessions lock").insert(session.to_string(), tx);
        rx
    }

    pub fn forget(&self, session: &str) {
        self.sessions.lock().expect("sessions lock").remove(session);
    }
}

/// A browser this run started, closed (and its profile removed) when dropped.
pub struct Browser {
    pub url: String,
    child: Option<Child>,
    profile: Option<PathBuf>,
}

impl Drop for Browser {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            child.kill().ok();
            child.wait().ok();
        }
        if let Some(profile) = &self.profile {
            std::fs::remove_dir_all(profile).ok();
        }
    }
}

/// The browser for the run: the one at `browser_url`, else Lightpanda or Chrome started here.
pub fn start(engine: &str, browser_url: &str, headed: bool) -> Result<Browser, String> {
    if !browser_url.is_empty() {
        return Ok(Browser { url: ws_url(browser_url)?, child: None, profile: None });
    }
    match engine {
        "lightpanda" => lightpanda(),
        "chrome" => chrome(headed),
        other => Err(format!("replay.browser must be chrome or lightpanda, got {other}")),
    }
}

/// A `ws://` URL as given, or the one an `http://` DevTools endpoint names in `/json/version`.
fn ws_url(url: &str) -> Result<String, String> {
    if url.starts_with("ws://") {
        return Ok(url.to_string());
    }
    let version: Value = ureq::get(&format!("{}/json/version", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(10))
        .call()
        .and_then(|answer| answer.into_json().map_err(Into::into))
        .map_err(|error| format!("cannot reach replay.browserUrl {url}: {error}"))?;
    version["webSocketDebuggerUrl"].as_str().map(String::from).ok_or_else(|| format!("{url}/json/version names no webSocketDebuggerUrl"))
}

/// Chrome Headless Shell when Playwright installed one (half the memory of full Chrome), else the installed Chrome.
fn chrome_path(headed: bool) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let caches = [home.join("Library/Caches/ms-playwright"), home.join(".cache/ms-playwright")];
    if !headed {
        for cache in caches.iter().filter(|dir| dir.is_dir()) {
            let mut shells: Vec<PathBuf> = std::fs::read_dir(cache)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("chromium_headless_shell-")))
                .collect();
            // Newest build first: chromium_headless_shell-1248 sorts after -1217.
            shells.sort_by_key(|path| std::cmp::Reverse(path.to_string_lossy().rsplit('-').next().and_then(|n| n.parse::<u32>().ok())));
            for shell in shells {
                for entry in std::fs::read_dir(&shell).into_iter().flatten().flatten() {
                    let binary = entry.path().join("chrome-headless-shell");
                    if binary.is_file() {
                        return Some(binary);
                    }
                }
            }
        }
    }
    let installed = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
    ];
    installed.iter().map(PathBuf::from).find(|path| path.is_file())
}

/// Starts Chrome on a free DevTools port with a throwaway profile, and reads the WebSocket URL it prints.
fn chrome(headed: bool) -> Result<Browser, String> {
    let path = chrome_path(headed).ok_or("intersite needs Google Chrome installed (https://www.google.com/chrome/), or Chrome Headless Shell: npx playwright install chromium-headless-shell")?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let profile = std::env::temp_dir().join(format!("intersite-chrome-{}-{nanos}", std::process::id()));
    let mut args = vec![
        "--remote-debugging-port=0".to_string(),
        format!("--user-data-dir={}", profile.display()),
        // Each flow is its own context in this one browser; background throttling would stall the ones not in front.
        "--disable-background-timer-throttling".into(),
        "--disable-backgrounding-occluded-windows".into(),
        "--disable-renderer-backgrounding".into(),
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-default-apps".into(),
        "--disable-extensions".into(),
        "--disable-sync".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--mute-audio".into(),
        "--password-store=basic".into(),
        "--use-mock-keychain".into(),
    ];
    if !headed {
        args.push("--headless".into());
    }
    args.push("about:blank".into());
    let mut child = Command::new(&path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", path.display()))?;
    let stderr = child.stderr.take().expect("stderr is piped");
    let (tx, rx) = channel();
    // Keeps draining stderr after the URL: a full pipe would block Chrome.
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(url) = line.split_whitespace().find(|word| word.starts_with("ws://")) {
                tx.send(url.to_string()).ok();
            }
        }
    });
    let mut browser = Browser { url: String::new(), child: Some(child), profile: Some(profile) };
    browser.url =
        rx.recv_timeout(Duration::from_secs(20)).map_err(|_| format!("{} printed no DevTools address within 20 s", path.display()))?;
    Ok(browser)
}

/// Starts `lightpanda serve` from PATH on a free local port and waits until it accepts connections.
fn lightpanda() -> Result<Browser, String> {
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|error| error.to_string())?.port();
    let child = Command::new("lightpanda")
        .args(["serve", "--host", "127.0.0.1", "--port", &port.to_string()])
        .env("LIGHTPANDA_DISABLE_TELEMETRY", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "replay.browser lightpanda needs the lightpanda binary on PATH; install it with curl -fsSL https://pkg.lightpanda.io/install.sh | bash (it goes to ~/.local/bin), or set replay.browserUrl to a running one".to_string())?;
    let browser = Browser { url: format!("ws://127.0.0.1:{port}/"), child: Some(child), profile: None };
    // ponytail: polls the port until it answers; read lightpanda's "listening" log line instead if its format is ever documented.
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(browser);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("lightpanda did not accept a connection on port {port} within 10 s"))
}
