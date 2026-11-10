import * as fsp from "node:fs/promises";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { locateAll, type LocatedRange } from "../../core/document-locate.ts";
import type { DocumentFormat, SessionDocument } from "../../core/documents.ts";
import { openPdfBytes } from "../subagents/pdf-ops.ts";
import { docxToHtml } from "./docx-html.ts";
import { DocumentAccessError, documentFile } from "./registry.ts";

/** A document's text, in the two shapes every consumer needs: SEGMENTS (what
 *  passage matching and the annotation writers run over: PDF text-item
 *  strings, docx/HTML text nodes, Markdown source lines) and the readable TEXT
 *  the agent reads (PDF under page markers, Word as Markdown, Markdown as-is). */
export interface DocumentText {
	format: DocumentFormat;
	pages?: { number: number; segments: string[]; text: string }[];
	segments: string[];
	text: string;
}

/** One pdf.js text item, the fields the viewer tools use. */
export interface PdfTextItem {
	str: string;
	hasEOL: boolean;
	transform: number[];
	width: number;
	height: number;
}

/** The text items of the given pages (all pages by default), via pdf.js. */
export async function readPdfPages(
	doc: Awaited<ReturnType<typeof openPdfBytes>>["doc"],
	which?: readonly number[],
): Promise<{ number: number; items: PdfTextItem[] }[]> {
	const numbers = which ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
	const out: { number: number; items: PdfTextItem[] }[] = [];
	for (const number of numbers) {
		const page = await doc.getPage(number);
		const content = await page.getTextContent();
		const items: PdfTextItem[] = [];
		for (const item of content.items) {
			if (typeof (item as { str?: unknown }).str !== "string") continue; // marked-content markers
			const t = item as unknown as PdfTextItem;
			items.push({ str: t.str, hasEOL: t.hasEOL === true, transform: [...t.transform], width: t.width, height: t.height });
		}
		out.push({ number, items });
		page.cleanup();
	}
	return out;
}

const NO_TEXT_LAYER = "(no text layer on this page)";

/** One PDF page as the agent reads it: its marker, then its text (or the no-text-layer note). */
export function pdfPageBlock(page: { number: number; text: string }): string {
	return `--- Page ${page.number} ---\n\n${page.text.trim() === "" ? NO_TEXT_LAYER : page.text}`;
}

async function pdfText(bytes: Uint8Array): Promise<DocumentText> {
	let opened: Awaited<ReturnType<typeof openPdfBytes>>;
	try {
		opened = await openPdfBytes(bytes.slice());
	} catch {
		throw new DocumentAccessError("This PDF could not be read.", 400);
	}
	try {
		const raw = await readPdfPages(opened.doc);
		const pages = raw.map(({ number, items }) => ({
			number,
			segments: items.map((i) => i.str),
			text: items.map((i) => (i.hasEOL ? `${i.str}\n` : i.str)).join(""),
		}));
		return {
			format: "pdf",
			pages,
			segments: pages.flatMap((p) => p.segments),
			text: pages.map(pdfPageBlock).join("\n\n"),
		};
	} finally {
		await opened.task.destroy();
	}
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
// Images arrive as data URIs; the agent reads the words, never the pixels.
turndown.addRule("lh-image", {
	filter: "img",
	replacement: (_content, node) => {
		const alt = (node as { getAttribute?: (name: string) => string | null }).getAttribute?.("alt");
		return alt ? `[image: ${alt}]` : "[image]";
	},
});

/** Text nodes of an HTML fragment in document order (what the browser's DOM walk sees). */
function htmlTextNodes(html: string): string[] {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const out: string[] = [];
	const visit = (node: Node): void => {
		for (const child of node.childNodes) {
			if (child.nodeType === 3) out.push(child.nodeValue ?? "");
			else if (child.nodeType === 1) visit(child);
		}
	};
	visit(document.body);
	return out;
}

async function docxText(bytes: Uint8Array): Promise<DocumentText> {
	let html: string;
	try {
		html = await docxToHtml(bytes);
	} catch {
		throw new DocumentAccessError("This Word document could not be read.", 400);
	}
	return { format: "docx", segments: htmlTextNodes(html), text: turndown.turndown(html) };
}

function markdownText(bytes: Uint8Array): DocumentText {
	const text = Buffer.from(bytes).toString("utf-8").replace(/^\uFEFF/, "");
	return { format: "markdown", segments: text.split(/\r?\n/), text };
}

const CACHE_LIMIT = 8;
const cache = new Map<string, DocumentText>();

/** The document's text; an in-memory LRU (8 entries) keyed by file + mtime + size. */
export async function documentText(doc: SessionDocument): Promise<DocumentText> {
	const file = documentFile(doc);
	let stat: Awaited<ReturnType<typeof fsp.stat>>;
	try {
		stat = await fsp.stat(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new DocumentAccessError(`File not found: ${file}`, 404, file);
		throw err;
	}
	const key = `${file}\0${stat.mtimeMs}\0${stat.size}`;
	const hit = cache.get(key);
	if (hit) {
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const bytes = new Uint8Array(await fsp.readFile(file));
	const value = doc.format === "pdf" ? await pdfText(bytes) : doc.format === "docx" ? await docxText(bytes) : markdownText(bytes);
	cache.set(key, value);
	while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
	return value;
}

export type PdfLocation =
	| { kind: "found"; page: number; range: LocatedRange; occurrence: number }
	| { kind: "not-found" }
	| { kind: "ambiguous"; count: number };

/** Locate a quote among PDF pages: the hint page first, then every page.
 *  Matches on ≥ 2 pages, or several on the page without a hint, are ambiguous.
 *  The range's segment indices are relative to the page's segments. */
export function locateInPdfPages(
	pages: readonly { number: number; segments: readonly string[] }[],
	quote: string,
	page?: number,
): PdfLocation {
	if (page !== undefined) {
		const hinted = pages.find((p) => p.number === page);
		const matches = hinted ? locateAll(hinted.segments, quote) : [];
		if (hinted && matches.length > 0) return { kind: "found", page, range: matches[0]!, occurrence: 0 };
	}
	const hits: { page: number; matches: LocatedRange[] }[] = [];
	for (const p of pages) {
		const matches = locateAll(p.segments, quote);
		if (matches.length > 0) hits.push({ page: p.number, matches });
	}
	if (hits.length === 0) return { kind: "not-found" };
	const total = hits.reduce((n, h) => n + h.matches.length, 0);
	if (total > 1) return { kind: "ambiguous", count: total };
	return { kind: "found", page: hits[0]!.page, range: hits[0]!.matches[0]!, occurrence: 0 };
}

export type LocateResult =
	| { kind: "found"; page?: number; occurrence: number }
	| { kind: "not-found" }
	| { kind: "ambiguous"; count: number };

/** Locate a quote in a document's text (the point_to_passage / propose_annotation seam). */
export function locateInDocument(text: DocumentText, quote: string, page?: number): LocateResult {
	if (text.format === "pdf" && text.pages) {
		const found = locateInPdfPages(text.pages, quote, page);
		return found.kind === "found" ? { kind: "found", page: found.page, occurrence: found.occurrence } : found;
	}
	const matches = locateAll(text.segments, quote);
	if (matches.length === 0) return { kind: "not-found" };
	if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
	return { kind: "found", occurrence: 0 };
}
