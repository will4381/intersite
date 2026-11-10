// @ts-check
import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared.mjs";

const PLACEHOLDER = /\blorem ipsum\b|\b(?:john|jane) doe\b|\bexample@example\.com\b|\byour (?:content|text|title|description|company|tagline|headline) (?:goes )?here\b|\bfeature (?:description|title) (?:goes )?here\b|^\s*feature description\s*$|\badd (?:your|a) description here\b/i;

/** Hint text inside an empty field is where sample values belong: placeholder="Jane Doe". @param {any} node */
function isHint(node) {
  const parent = node.parent;
  if (parent?.type === "JSXAttribute") return /placeholder/i.test(parent.name.name);
  if (parent?.type === "JSXExpressionContainer" && parent.parent?.type === "JSXAttribute") return /placeholder/i.test(parent.parent.name.name);
  if (parent?.type === "Property") return /placeholder/i.test(parent.key.name ?? parent.key.value ?? "");
  return false;
}

export const id = "no-placeholder-copy";
export const pack = "slop";
export const ext = "tsx";

export const rule = defineRule({
  meta: {
    type: "problem",
    messages: {
      copy: "\"{{text}}\" is template filler, and it ships to users looking finished. Write the real copy, or leave the section out until there is some. (Sample values in an input's placeholder are fine.)",
    },
  },
  createOnce(context) {
    /** @param {any} node @param {string} text */
    function check(node, text) {
      const match = PLACEHOLDER.exec(text);
      if (match && !isHint(node)) context.report({ node, messageId: "copy", data: { text: match[0].trim() } });
    }
    return {
      // UI files only: a server-side preview that renders a sample Slack message "by Jane Doe" is a fixture by design.
      before: () => /\.[jt]sx$/.test(context.filename) && !isTestFile(context),
      JSXText: (node) => check(node, node.value),
      Literal: (node) => typeof node.value === "string" && check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked ?? ""),
    };
  },
});

export const bad = [
  "export const Hero = () => <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>;",
  "export const team = [{ name: 'John Doe', role: 'CEO' }];",
  "export const Contact = () => <a href=\"mailto:example@example.com\">Email us</a>;",
  "export const About = () => <section><h2>Your headline here</h2></section>;",
];

export const good = [
  "export const Name = () => <input placeholder=\"Jane Doe\" />;",
  "export const fields = [{ label: 'Email', placeholder: 'example@example.com' }];",
  "export const Hero = () => <p>Book a walk in two taps.</p>;",
  "export const Soon = () => <span>Coming soon</span>;",
  "export const email = 'jane.doe@acme.com';",
];
