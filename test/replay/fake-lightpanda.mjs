// @ts-check
// Stands in for `lightpanda serve --host <h> --port <p>` in the tests: starts headless Chrome and answers the
// DevTools WebSocket at ws://<h>:<p>/ the way Lightpanda does, by passing each connection through to Chrome's
// browser endpoint. It proves Intersite's start, connect and stop path, not Lightpanda's compatibility.
// Writes its arguments to $FAKE_LIGHTPANDA_LOG.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: process.argv.slice(3), options: { host: { type: "string" }, port: { type: "string" } } });
appendFileSync(String(process.env.FAKE_LIGHTPANDA_LOG), `${process.argv.slice(2).join(" ")}\n`);
const chrome = spawn(String(process.env.FAKE_LIGHTPANDA_CHROME), [
  "--headless", "--remote-debugging-port=0", `--user-data-dir=${mkdtempSync(join(tmpdir(), "fake-lightpanda-"))}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const server = createServer();
let log = "";
let started = false;
chrome.stderr.on("data", (chunk) => {
  log += chunk;
  const found = /DevTools listening on ws:\/\/[^:]+:(\d+)(\/devtools\/browser\/\S+)/.exec(log);
  if (!found || started) return;
  started = true;
  const [, port, path] = found;
  server.on("connection", (socket) => {
    socket.once("data", (head) => {
      const upstream = connect(Number(port), "127.0.0.1");
      upstream.write(head.toString("latin1").replace(/^GET \/ /, `GET ${path} `), "latin1");
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    });
  }).listen(Number(values.port), values.host);
});
process.on("SIGTERM", () => { chrome.kill(); chrome.once("close", () => process.exit(0)); });
