// @ts-check
import { relative } from "node:path";

import { defineRule } from "@oxlint/plugins";

import { enclosingFunction, inTestPaths } from "./shared.mjs";

/** A step or outcome of one operation: `isLoading`, `saving`, `hasLoaded`, `submitError`, `serverPreviewFailed`. */
const phaseWords =
  "loading|loaded|saving|saved|submitting|submitted|sending|sent|deleting|deleted|uploading|uploaded|fetching|fetched|processing|processed|creating|created|updating|removing|exporting|importing|refreshing|retrying|connecting|connected|publishing|published|pending|busy|error|errored|failed|failure|success|succeeded|done|complete|completed|finished|cancelled|canceled";
const words = new Set(phaseWords.split("|"));
const phaseSuffix = new RegExp(`[a-z0-9](?:${[...words].map((w) => w[0].toUpperCase() + w.slice(1)).join("|")})$`);
/** @param {string} name */
const isPhase = (name) => words.has(name.replace(/^(?:is|has|did|was)(?=[A-Z])/, "").toLowerCase()) || phaseSuffix.test(name);

/** Test helpers outside the usual test paths, such as `src/test/query.tsx` building a mocked useMutation result. */
const testHelper = /(?:^|\/)(?:test|tests|__mocks__|mocks?|__fixtures__|fixtures?)\//;

/** @param {any} node */
const isBoolean = (node) => node?.type === "Literal" && typeof node.value === "boolean";

/** A reactive cell: React's useState, Solid's createSignal, Vue's ref, Svelte's $state, Preact and Angular signals. */
const stateHook = /^(?:useState|createSignal|ref|shallowRef|signal|\$state)$/;

/** `useState(false)`, `React.useState(true)`, `ref(false)`, `createSignal(false)`. @param {any} node */
const isBooleanState = (node) =>
  node?.type === "CallExpression" &&
  stateHook.test(node.callee.name ?? node.callee.property?.name ?? "") &&
  isBoolean(node.arguments[0]);

export const id = "no-boolean-state-cluster";
export const pack = "state";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      cluster: 'These boolean flags ({{flags}}) encode one state between them, so combinations that cannot happen (saving and failed at once) are representable and must be guarded everywhere. Use one state value with named states, such as useState<"idle" | "saving" | "saved" | "failed">("idle").',
    },
  },
  createOnce(context) {
    /** @type {Map<any, { first: any, names: string[], phases: number }>} owner -> its flags */
    let owners = new Map();

    /**
     * @param {any} owner the function, class body or object literal the flag belongs to
     * @param {any} node
     * @param {string} name
     * @param {boolean} anyName whether a non-phase name still counts (React state flags)
     */
    function flag(owner, node, name, anyName) {
      const named = isPhase(name);
      if (!owner || (!named && !anyName)) return;
      const entry = owners.get(owner) ?? { first: node, names: [], phases: 0 };
      entry.names.push(name);
      if (named) entry.phases++;
      owners.set(owner, entry);
    }

    return {
      // Test files build these clusters on purpose, as mocks of query results.
      before() {
        owners = new Map();
        return !inTestPaths(context) && !testHelper.test(relative(context.cwd, context.filename));
      },
      VariableDeclarator(node) {
        if (isBooleanState(node.init) && node.id.type === "ArrayPattern" && node.id.elements[0]?.type === "Identifier") {
          flag(enclosingFunction(node), node, node.id.elements[0].name, true);
        } else if (isBooleanState(node.init) && node.id.type === "Identifier") {
          flag(enclosingFunction(node), node, node.id.name, true);
        } else if (isBoolean(node.init) && node.id.type === "Identifier" && node.parent.kind !== "const") {
          flag(enclosingFunction(node), node, node.id.name, false);
        }
      },
      PropertyDefinition(node) {
        if (isBoolean(node.value) && (node.key.type === "Identifier" || node.key.type === "PrivateIdentifier")) flag(node.parent, node, node.key.name, false);
      },
      Property(node) {
        if (isBoolean(node.value) && node.key.type === "Identifier") flag(node.parent, node, node.key.name, false);
      },
      "Program:exit"() {
        for (const { first, names, phases } of owners.values()) {
          // Mostly phase flags: a form with a checkbox, a mode and one `submitting` flag is not one state.
          if (names.length >= 3 && phases >= 2 && phases * 2 >= names.length) context.report({ node: first, messageId: "cluster", data: { flags: names.join(", ") } });
        }
      },
    };
  },
});

export const bad = [
  "export function Profile() {\n  const [deleteOpen, setDeleteOpen] = useState(false);\n  const [isDeleting, setIsDeleting] = useState(false);\n  const [isSaving, setIsSaving] = useState(false);\n  return null;\n}",
  "export function useUpload() {\n  const [uploading, setUploading] = React.useState(false);\n  const [failed, setFailed] = React.useState(false);\n  const [done, setDone] = React.useState(false);\n  return { uploading, failed, done };\n}",
  "export function load() {\n  let isLoading = true;\n  let hasLoaded = false;\n  let isError = false;\n  return fetch('/x').then(() => { isLoading = false; hasLoaded = true; }, () => { isError = true; });\n}",
  "export class Form {\n  submitting = false;\n  submitted = false;\n  submitError = false;\n}",
  "export const initial = { loading: false, saved: false, failed: false };",
  "export function useSave() {\n  const isLoading = ref(false);\n  const isSaving = ref(false);\n  const hasError = ref(false);\n  return { isLoading, isSaving, hasError };\n}",
  "export function Upload() {\n  const [uploading, setUploading] = createSignal(false);\n  const [failed, setFailed] = createSignal(false);\n  const [done, setDone] = createSignal(false);\n  return null;\n}",
  "export class Form {\n  #submitting = false;\n  #submitted = false;\n  #submitError = false;\n}",
];

export const good = [
  "export function Filters() {\n  const [showArchived, setShowArchived] = useState(false);\n  const [onlyMine, setOnlyMine] = useState(false);\n  const [compact, setCompact] = useState(true);\n  return null;\n}",
  "export function Calendar() {\n  const [overlayPto, setOverlayPto] = useState(false);\n  const [overlayShifts, setOverlayShifts] = useState(false);\n  const [exporting, setExporting] = useState(false);\n  return null;\n}",
  "export function Save() {\n  const [status, setStatus] = useState('idle');\n  const [open, setOpen] = useState(false);\n  return null;\n}",
  "export const options = { enabled: true, retry: false, refetchOnWindowFocus: false };",
  "export function Booking() {\n  const [isEditMode, setIsEditMode] = useState(false);\n  const [canProceed, setCanProceed] = useState(false);\n  const [termsAccepted, setTermsAccepted] = useState(false);\n  const [previewFailed, setPreviewFailed] = useState(false);\n  const [submitting, setSubmitting] = useState(false);\n  return null;\n}",
  "export function Menu() { const [, setOpen] = useState(false); const [ready] = useState(); return ready; }",
  "export function A() { const [saving, setSaving] = useState(false); return null; }\nexport function B() { const [failed, setFailed] = useState(false); return null; }\nexport function C() { const [done, setDone] = useState(false); return null; }",
];
