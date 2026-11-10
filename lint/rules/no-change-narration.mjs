// @ts-check
import { commentRule } from "../comment-rule.mjs";

const edited = "(?:Added|Updated|Changed|Modified|Fixed|Removed|Replaced|Refactored|Moved|Renamed|Reverted|Tweaked|Adjusted)";
/**
 * Each pattern reads as the history of an edit, not as a description of the code. A comment that only starts with a
 * past participle ("Removed creators leave the list", "Fixed colors for the stages") describes code and is left alone.
 */
const narration = [
  // Matches tags such as `NEW: handle nulls`, `FIXED - off by one`, `Fixed: was off by one`.
  /^(?:NEW|CHANGED|UPDATED|FIXED|FIX|ADDED|REMOVED|MODIFIED)(?:\s*[:!]|\s+-\s)/,
  /^(?:Fixed|Updated|Modified)\s*:/,
  // Matches a reason for the edit: `Added to fix the login bug`, `Updated per review`, `Changed for #42`.
  new RegExp(
    `^${edited}\\b.{0,40}?(?:\\bto (?:fix|address|resolve)\\b|\\b(?:per|after) (?:code |the )?(?:review|pr|feedback|reviewer|request|ticket|issue)\\b|\\bas requested\\b|\\bbased on (?:review|feedback)\\b|\\bin response to\\b|\\bfor (?:the )?(?:bug|ticket|pr)\\b|#\\d+)`,
    "i",
  ),
  // Matches an old and a new value: `Changed from 5 to 10`, `Bumped timeout from '30s' to '60s'`.
  /^(?:Changed|Updated|Increased|Decreased|Bumped|Reduced|Raised|Lowered)\s+(?:\S+\s+){0,3}?from\s+(?:\d[\w.]*|'[^']*'|"[^"]*"|`[^`]*`)\s+to\s+/i,
  // Matches what an edit took away: `Removed old logic`, `Replaced the legacy parser`.
  /^(?:Removed|Deleted|Dropped|Replaced|Commented out)\s+(?:the\s+)?(?:old|previous|legacy|unused|dead|original|deprecated|redundant|duplicate)\b/i,
  // Matches a new way of working: `Updated to use the new client`, `Refactored to use hooks`, `Now uses async/await`.
  /^(?:Changed|Updated|Refactored|Modified|Switched|Migrated|Converted|Rewritten|Rewrote)\s+(?:it\s+|this\s+)?to\s+(?:use|using|now|handle|support|call|return|async)\b/i,
  /^(?:Now|We now|This now|It now)\s+(?:uses?|handles?|returns?|calls?|supports?|works)\b/i,
  // Matches what the code used to do: `Previously this used a loop`.
  /^Previously,?\s+(?:this|we|it|the code|the function)\b/i,
  // Matches tool credits: `Added by Claude`, `Generated with Copilot`.
  /^(?:Added|Generated|Written|Updated|Created|Modified)\s+(?:by|with|using)\s+(?:Claude|Copilot|ChatGPT|GPT|Cursor|Codex|Gemini|AI|an?\s+(?:AI|LLM|assistant))\b/i,
];

export const id = "no-change-narration";
export const pack = "slop";

export const rule = commentRule(
  "This comment narrates an edit (what was added, changed or fixed) instead of describing the code. Put the history in the commit message; keep a comment only if it says why the code is the way it is now.",
  (first) => narration.some((pattern) => pattern.test(first)),
);

export const bad = [
  "// Added to fix the login bug\nexport const retries = 3;",
  "// Updated per review\nexport const limit = 50;",
  "// NEW: handle nulls\nexport const name = (u) => u?.name ?? '';",
  "export const timeout = 10; // Changed from 5 to 10",
  "// Fixed: was off by one\nexport const last = (a) => a[a.length - 1];",
  "// Removed old logic\nexport const run = () => 1;",
  "// Updated to use the new API client\nexport const client = 1;",
  "// Now uses async/await instead of callbacks\nexport const load = 1;",
  "// Previously this used a for loop\nexport const sum = 1;",
];

export const good = [
  "// Fix the timezone before comparing: stored dates are UTC.\nexport const tz = 'UTC';",
  "// Removed creators leave the roster list.\nexport const roster = [];",
  "/** Fixed colors for the three funnel stages. */\nexport const colors = ['a', 'b', 'c'];",
  "// A new session starts when the old one expires.\nexport const session = 1;",
  "// Changed fields only, as one POST per object.\nexport const patch = 1;",
  "// FIX-23: a revision approved with its submission books the fee once.\nexport const fee = 1;",
  "// Updated programs drop out of the selection.\nexport const selection = [];",
  "// Now that the session is loaded, render the shell.\nexport const shell = 1;",
  "// Previously selected rows stay checked.\nexport const keep = 1;",
  "/**\n * removed: only in the answer to PATCH /v1/members/:id.\n */\nexport type Status = 'active' | 'removed';",
];
