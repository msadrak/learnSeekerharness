/**
 * Text direction for mixed Persian/English content (Persian locale wave).
 *
 * THE RULE (owner-approved): a block containing ANY Persian/Arabic letter
 * is right-to-left; otherwise left-to-right. The browser's first-strong-
 * character rule (dir="auto") gets the most common Persian technical
 * sentence wrong — "LaTeX یک زبان است" opens with a Latin word and would
 * render LTR. Math and code never vote: they are always LTR islands,
 * isolated so a formula can't reorder the Persian around it (globals.css
 * pins .katex / code to direction: ltr + unicode-bidi: isolate).
 *
 * Applies in BOTH UI languages: the agents follow the learner's language,
 * so a Persian reply can arrive inside the English chrome.
 */

import type { Element, ElementContent, Root, RootContent } from "hast";
import type { UiLanguage } from "@/src/core";

export type TextDirection = "ltr" | "rtl";

/** The UI chrome's writing direction for a language. */
export function languageDirection(language: UiLanguage): TextDirection {
	return language === "fa" ? "rtl" : "ltr";
}

/** An Arabic-script LETTER (Persian is Arabic script). Digits and
 *  punctuation are excluded — "۱۲" or "،" alone don't make a block RTL. */
const ARABIC_SCRIPT_LETTER = /(?=\p{L})\p{Script=Arabic}/u;

/** The direction rule over plain text. */
export function textDirection(text: string): TextDirection {
	return ARABIC_SCRIPT_LETTER.test(text) ? "rtl" : "ltr";
}

/** The rule for a text field the learner types into: empty = inherit the
 *  page direction (so a Persian placeholder sits right in the Persian UI),
 *  otherwise follow the typed text, live. */
export function inputDirection(value: string): TextDirection | undefined {
	return value ? textDirection(value) : undefined;
}

/** The blocks that get an explicit dir. Lists and tables carry one too so
 *  bullets/numbers and column order follow their content. */
const DIRECTED_BLOCKS: Record<string, true> = {
	p: true, li: true, ul: true, ol: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
	blockquote: true, table: true, td: true, th: true, dt: true, dd: true,
};

/** Elements whose text never votes: code and math (before rehype-katex
 *  they are code.language-math / pre; after, span.katex*). */
function isLtrIsland(el: Element): boolean {
	if (el.tagName === "code" || el.tagName === "pre") return true;
	// hast normalizes className to a token array.
	const cls = el.properties?.className;
	if (!Array.isArray(cls)) return false;
	return cls.some((c) => c === "katex" || c === "katex-display" || String(c).startsWith("math"));
}

/** True when any voting text under `node` contains an Arabic-script letter. */
function hasRtlText(node: Root | ElementContent | RootContent): boolean {
	if (node.type === "text") return ARABIC_SCRIPT_LETTER.test(node.value);
	if (node.type === "element") {
		if (isLtrIsland(node)) return false;
		return node.children.some(hasRtlText);
	}
	if (node.type === "root") return node.children.some(hasRtlText);
	return false;
}

function walk(node: Root | Element): void {
	for (const child of node.children) {
		if (child.type !== "element") continue;
		if (isLtrIsland(child)) {
			child.properties = { ...child.properties, dir: "ltr" };
			continue;
		}
		if (DIRECTED_BLOCKS[child.tagName]) {
			child.properties = { ...child.properties, dir: hasRtlText(child) ? "rtl" : "ltr" };
		}
		walk(child);
	}
}

/** rehype plugin: stamps dir on every block per the rule above. Runs
 *  after sanitize (so the attribute survives) and before rehype-katex. */
export function rehypeBidi() {
	return (tree: Root) => {
		walk(tree);
	};
}
