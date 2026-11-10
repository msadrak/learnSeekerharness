import { locateAll } from "@/src/core";

/**
 * DOM side of the document viewer's passage matching: the same `locateAll`
 * the server uses, run over the text nodes of a rendered document (a PDF
 * page's text layer, the Word HTML, the rendered Markdown). Highlights use
 * the CSS Custom Highlight API so the DOM is never mutated.
 */

/** The text nodes under `root`, in document order. */
export function textNodesIn(root: Node): Text[] {
	const nodes: Text[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
	return nodes;
}

/** Every match of `quote` under `root` as a live Range (whitespace, case,
 *  punctuation and Arabic/Persian variants are ignored by the matcher). */
export function rangesForQuote(root: Node, quote: string): Range[] {
	const nodes = textNodesIn(root);
	if (nodes.length === 0) return [];
	const located = locateAll(nodes.map((n) => n.data), quote);
	const ranges: Range[] = [];
	for (const { start, end } of located) {
		const first = nodes[start.segment];
		const last = nodes[end.segment];
		if (!first || !last) continue;
		const range = document.createRange();
		range.setStart(first, start.offset);
		range.setEnd(last, end.offset);
		ranges.push(range);
	}
	return ranges;
}

/** The order of `b` relative to `a`: -1 before, 0 equal, 1 after. */
function comparePoints(a: { node: Node; offset: number }, b: { node: Node; offset: number }): number {
	const probe = document.createRange();
	probe.setStart(a.node, a.offset);
	probe.collapse(true);
	return probe.comparePoint(b.node, b.offset);
}

/** Index of the match the selection `range` starts in, among all matches of
 *  `quote` under `root` (the excerpt's `occurrence`). 0 when it cannot be told. */
export function occurrenceOf(root: Node, range: Range, quote: string): number {
	const matches = rangesForQuote(root, quote);
	const start = { node: range.startContainer, offset: range.startOffset };
	const index = matches.findIndex((m) => comparePoints(start, { node: m.endContainer, offset: m.endOffset }) > 0);
	return index < 0 ? 0 : index;
}

const HEADING = "h1,h2,h3,h4,h5,h6";

/** Text of the nearest heading in `root` that precedes `node` (document order). */
export function headingAbove(root: Element, node: Node): string | undefined {
	let found: Element | undefined;
	for (const heading of root.querySelectorAll(HEADING)) {
		if (heading.contains(node) || node.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING) found = heading;
		else break;
	}
	return headingText(found);
}

/** Text of the last heading in `root` whose top is at or above `scrollTop` of `container`. */
export function headingAtScrollTop(root: Element, container: Element): string | undefined {
	const limit = container.getBoundingClientRect().top + 8;
	let found: Element | undefined;
	for (const heading of root.querySelectorAll(HEADING)) {
		if (heading.getBoundingClientRect().top <= limit) found = heading;
		else break;
	}
	return headingText(found);
}

function headingText(heading: Element | undefined): string | undefined {
	const text = heading?.textContent?.replace(/\s+/g, " ").trim().slice(0, 200);
	return text || undefined;
}

/** Scroll `container` so `range` sits in its vertical centre. */
export function scrollRangeToCenter(container: HTMLElement, range: Range): void {
	const rect = range.getBoundingClientRect();
	const box = container.getBoundingClientRect();
	const top = container.scrollTop + (rect.top - box.top) - box.height / 2 + rect.height / 2;
	container.scrollTo({ top: Math.max(0, top) });
}

// ─── CSS Custom Highlight API ────────────────────────────────────────────────

export type HighlightName = "lh-doc-flash" | "lh-doc-pending" | "lh-doc-annotation";

function highlightRegistry(): HighlightRegistry | null {
	return typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
}

/** Replace the ranges of one named highlight (an empty list removes it). */
export function setHighlight(name: HighlightName, ranges: readonly Range[]): void {
	const registry = highlightRegistry();
	if (!registry) return;
	if (ranges.length === 0) registry.delete(name);
	else registry.set(name, new Highlight(...ranges));
}

export function clearHighlights(): void {
	const registry = highlightRegistry();
	if (!registry) return;
	for (const name of ["lh-doc-flash", "lh-doc-pending", "lh-doc-annotation"] as const) registry.delete(name);
}
