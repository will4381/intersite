// @ts-check
import { defineRule } from "@oxlint/plugins";

import { calleeName, constInit, resolveVariable, unwrap } from "../shared.mjs";
import { firstDynamic, pieces } from "./no-interpolated-sql.mjs";

// child_process functions that run their string through a shell, also as commonly promisified.
const SHELL = /^(exec|execSync|execAsync|execPromise|execP|pExec)$/;
const CHILD_PROCESS = /^(child_?process|cp|childProcess)$/;
// Functions that take an argument list, and go through a shell only with `{ shell: true }` or `sh -c`.
const SPAWN = /^(spawn|spawnSync|execFile|execFileSync|execa|execaSync|execaCommand)$/;
const SH = /^(sh|bash|zsh|\/bin\/(ba|z)?sh|cmd|cmd\.exe|powershell|pwsh)$/;

/** `child_process`, `cp`, `require('child_process')`, or any name imported from it. @param {any} node @param {any} sourceCode */
function isChildProcess(node, sourceCode) {
  node = unwrap(node);
  if (node?.type === "CallExpression") return node.callee.name === "require" && String(node.arguments[0]?.value).endsWith("child_process");
  if (node?.type !== "Identifier") return false;
  const def = resolveVariable(node, sourceCode)?.defs[0];
  return CHILD_PROCESS.test(node.name) || (def?.type === "ImportBinding" && String(def.parent?.source?.value).endsWith("child_process"));
}

/** `exec`, `cp.exec`, `promisify(exec)`, or a `const run = promisify(cp.exec)`. @param {any} callee @param {any} sourceCode */
function runsShell(callee, sourceCode) {
  callee = unwrap(callee);
  if (callee.type === "CallExpression") return calleeName(callee) === "promisify" && Boolean(callee.arguments[0]) && runsShell(callee.arguments[0], sourceCode);
  if (callee.type === "MemberExpression") return !callee.computed && /^(exec|execSync)$/.test(callee.property.name) && isChildProcess(callee.object, sourceCode);
  if (callee.type !== "Identifier") return false;
  if (SHELL.test(callee.name)) return true;
  const init = unwrap(constInit(callee, sourceCode));
  return init?.type === "CallExpression" && calleeName(init) === "promisify" && runsShell(init, sourceCode);
}

/** The command string a call hands to a shell, if it does. @param {any} node @param {any} sourceCode */
function shellCommand(node, sourceCode) {
  const [first, second] = node.arguments;
  if (runsShell(node.callee, sourceCode)) return first;
  if (!SPAWN.test(calleeName(node))) return undefined;
  if (node.arguments.some((/** @type {any} */ a) => a.type === "ObjectExpression" && a.properties.some((/** @type {any} */ p) => p.key?.name === "shell" && p.value.value !== false))) return first;
  // spawn('sh', ['-c', command])
  const list = unwrap(second);
  if (SH.test(unwrap(first)?.value ?? "") && list?.type === "ArrayExpression" && /^[-/](c|Command)$/.test(list.elements[0]?.value ?? "")) return list.elements[1];
  return undefined;
}

export const id = "no-shell-injection";
export const pack = "security";
// ponytail: a command built with `let`/`+=` or passed through a helper's parameter, and wrappers such as shelljs `exec`, zx `$` with `quote: false`, or execaCommand, are not reported.

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      shell: "`{{value}}` is written into a shell command, so a value containing ; or $( ) runs commands of its own. Pass arguments as an array to a function that never starts a shell: execFile('git', ['log', ref]) or spawn('git', ['log', ref]) (without shell: true).",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const command = shellCommand(node, context.sourceCode);
        const parts = command && pieces(command, context.sourceCode);
        const value = parts && firstDynamic(parts, context.sourceCode, false);
        if (value) context.report({ node: value, messageId: "shell", data: { value: context.sourceCode.getText(value).slice(0, 40) } });
      },
    };
  },
});

export const bad = [
  "exec(`convert ${input} out.png`);",
  "const out = execSync(`git log ${branch} --oneline`, { encoding: 'utf8' });",
  "child_process.exec('rm -rf ' + dir);",
  "execSync('ffmpeg -i ' + file + ' out.mp4');",
  "const { stdout } = await execAsync(`du -sh ${path}`);",
  "import { exec } from 'node:child_process';\nconst cmd = `git log ${branch}`;\nexec(cmd);",
  "await execa(`convert ${input} out.png`, { shell: true });",
  "spawn('sh', ['-c', `cat ${file}`]);",
  "import proc from 'node:child_process';\nproc.execSync(`du -sh ${p}`);",
  "const { stdout } = await promisify(exec)(`whois ${domain}`);",
  "require('child_process').exec(`ping ${host}`);",
  "const run = util.promisify(cp.exec);\nawait run(`tar xf ${archive}`);",
  "execSync(['git', 'checkout', branch].join(' '));",
];

export const good = [
  "execFile('convert', [input, 'out.png']);",
  "execSync('git rev-parse HEAD');",
  "execSync(`npm run ${SCRIPT_NAME}`);",
  "const match = pattern.exec(`${first} ${last}`);",
  "const row = await db.exec(`SELECT 1`);",
  "const cmd = 'git status';\nexecSync(cmd);",
  "spawn('ffmpeg', ['-i', file, 'out.mp4']);",
  "import { BIN } from './paths';\nexecSync(`${BIN} --version`);",
  "await $`ls ${dir}`;",
];
