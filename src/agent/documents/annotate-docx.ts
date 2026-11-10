import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { locateAll } from "../../core/document-locate.ts";
import { AUTHOR, failed, type AnnotationInput, type AnnotationOutcome } from "./annotation-types.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const REL_COMMENTS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const COMMENTS_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const DEFAULT_DECLARATION = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const UNSUPPORTED = "This passage can’t be annotated";

/** w:rPr children that follow w:highlight in the schema order. */
const AFTER_HIGHLIGHT = ["u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath", "rPrChange"];
const TRACKED_OR_FIELD = ["ins", "del", "moveFrom", "moveTo", "fldSimple"];

type El = Element;

function wChildren(parent: El, localName?: string): El[] {
	const out: El[] = [];
	for (let n = parent.firstChild; n; n = n.nextSibling) {
		if (n.nodeType === 1 && (n as El).namespaceURI === W && (localName === undefined || (n as El).localName === localName)) out.push(n as El);
	}
	return out;
}

function wEl(doc: Document, name: string, attrs: Record<string, string> = {}): El {
	const el = doc.createElementNS(W, `w:${name}`);
	for (const [k, v] of Object.entries(attrs)) el.setAttributeNS(W, `w:${k}`, v);
	return el;
}

function setText(t: El, text: string): void {
	while (t.firstChild) t.removeChild(t.firstChild);
	t.appendChild(t.ownerDocument.createTextNode(text));
	t.setAttributeNS(XML_NS, "xml:space", "preserve");
}

function insertAfter(parent: Node, node: Node, ref: Node): void {
	parent.insertBefore(node, ref.nextSibling);
}

function ancestorsOf(node: Node): El[] {
	const out: El[] = [];
	for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) out.push(p as El);
	return out;
}

const isW = (el: El | null | undefined, name: string): boolean => !!el && el.namespaceURI === W && el.localName === name;

/** Is this w:t a plain run text we can split and highlight? */
function plainRunText(t: El, paragraph: El): boolean {
	const run = t.parentNode as El | null;
	if (!isW(run, "r")) return false;
	const holder = run!.parentNode as El | null;
	if (!(holder === paragraph || (isW(holder, "hyperlink") && holder!.parentNode === paragraph))) return false;
	if (ancestorsOf(run!).some((a) => a.namespaceURI === W && TRACKED_OR_FIELD.includes(a.localName))) return false;
	return !wChildren(run!).some((c) => c.localName === "fldChar" || c.localName === "instrText");
}

/** Run content children (everything except w:rPr). */
function content(run: El): El[] {
	return wChildren(run).filter((c) => c.localName !== "rPr");
}

function shallowRunClone(run: El): El {
	const clone = run.cloneNode(false) as El;
	const rPr = wChildren(run, "rPr")[0];
	if (rPr) clone.appendChild(rPr.cloneNode(true));
	return clone;
}

/** Split `run` before `offset` of its w:t: returns the run that starts at the match. */
function splitBefore(run: El, t: El, offset: number): El {
	const text = t.textContent ?? "";
	const kids = content(run);
	const idx = kids.indexOf(t);
	const before = kids.slice(0, idx);
	if (before.length === 0 && offset === 0) return run;
	const right = shallowRunClone(run);
	const rightT = t.cloneNode(false) as El;
	setText(rightT, text.slice(offset));
	right.appendChild(rightT);
	for (const k of kids.slice(idx + 1)) right.appendChild(k);
	if (offset === 0) run.removeChild(t);
	else setText(t, text.slice(0, offset));
	insertAfter(run.parentNode!, right, run);
	return right;
}

/** Split `run` after `offset` of its w:t: returns the run that ends at the match. */
function splitAfter(run: El, t: El, offset: number): El {
	const text = t.textContent ?? "";
	const kids = content(run);
	const idx = kids.indexOf(t);
	const after = kids.slice(idx + 1);
	if (after.length === 0 && offset >= text.length) return run;
	const right = shallowRunClone(run);
	if (offset < text.length) {
		const rightT = t.cloneNode(false) as El;
		setText(rightT, text.slice(offset));
		right.appendChild(rightT);
	}
	for (const k of after) right.appendChild(k);
	setText(t, text.slice(0, offset));
	insertAfter(run.parentNode!, right, run);
	return run;
}

function highlight(run: El): void {
	const doc = run.ownerDocument;
	let rPr = wChildren(run, "rPr")[0];
	if (!rPr) {
		rPr = wEl(doc, "rPr");
		run.insertBefore(rPr, run.firstChild);
	} else if (run.firstChild !== rPr) {
		run.insertBefore(rPr, run.firstChild);
	}
	for (const old of wChildren(rPr, "highlight")) rPr.removeChild(old);
	const mark = wEl(doc, "highlight", { val: "yellow" });
	const anchor = wChildren(rPr).find((c) => AFTER_HIGHLIGHT.includes(c.localName));
	if (anchor) rPr.insertBefore(mark, anchor);
	else rPr.appendChild(mark);
}

function maxWId(doc: Document, names: string[]): number {
	let max = -1;
	for (const name of names) {
		const nodes = doc.getElementsByTagNameNS(W, name);
		for (let i = 0; i < nodes.length; i++) {
			const id = Number(nodes[i]!.getAttributeNS(W, "id"));
			if (Number.isFinite(id)) max = Math.max(max, id);
		}
	}
	return max;
}

function parseXml(xml: string): Document {
	return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}

function serialize(doc: Document, original: string | null): string {
	const body = new XMLSerializer().serializeToString(doc as never);
	if (body.startsWith("<?xml")) return body;
	const declaration = original ? /^<\?xml[^>]*\?>\s*/.exec(original)?.[0].trim() : undefined;
	return `${declaration ?? DEFAULT_DECLARATION}\r\n${body}`;
}

/** The comments part's zip path for this document, or null when none is related. */
function commentsPartOf(rels: Document): string | null {
	const list = rels.getElementsByTagName("Relationship");
	for (let i = 0; i < list.length; i++) {
		const rel = list[i]!;
		if (rel.getAttribute("Type") !== REL_COMMENTS) continue;
		const target = rel.getAttribute("Target") ?? "";
		return target.startsWith("/") ? target.slice(1) : `word/${target}`;
	}
	return null;
}

/** Write Word comments (author "LearnHarness", initials "LH") with a yellow highlight on the
 *  commented runs. Passages in tracked changes, fields or text boxes are refused. */
export async function annotateDocx(
	bytes: Uint8Array,
	items: readonly AnnotationInput[],
	now: Date,
): Promise<{ bytes: Uint8Array | null; outcomes: AnnotationOutcome[] }> {
	const zip = await JSZip.loadAsync(bytes);
	const documentXml = await zip.file("word/document.xml")?.async("string");
	if (documentXml === undefined) {
		return { bytes: null, outcomes: items.map((i) => failed(i.id, "unsupported", UNSUPPORTED)) };
	}
	const doc = parseXml(documentXml);
	const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");
	const rels = relsXml !== undefined ? parseXml(relsXml) : null;
	const existingPart = rels ? commentsPartOf(rels) : null;
	const partName = existingPart ?? "word/comments.xml";
	const existingCommentsXml = existingPart ? await zip.file(existingPart)?.async("string") : undefined;
	const comments = existingCommentsXml !== undefined ? parseXml(existingCommentsXml) : parseXml(`<w:comments xmlns:w="${W}"/>`);
	const commentsRoot = comments.documentElement as El;
	const isoDate = now.toISOString().replace(/\.\d{3}Z$/, "Z");

	let nextId = Math.max(maxWId(doc, ["commentRangeStart", "commentRangeEnd", "commentReference"]), maxWId(comments, ["comment"])) + 1;
	const outcomes: AnnotationOutcome[] = [];
	let written = 0;

	for (const item of items) {
		const texts = doc.getElementsByTagNameNS(W, "t");
		const list: El[] = [];
		for (let i = 0; i < texts.length; i++) list.push(texts[i] as unknown as El);
		const match = locateAll(list.map((t) => t.textContent ?? ""), item.quote)[0];
		if (!match) {
			outcomes.push(failed(item.id, "not-found", "Passage not found in the file"));
			continue;
		}
		const touched = list.slice(match.start.segment, match.end.segment + 1);
		const paragraph = touched[0]!.parentNode?.parentNode && ancestorsOf(touched[0]!).find((a) => isW(a, "p"));
		const sameParagraph = paragraph && touched.every((t) => ancestorsOf(t).find((a) => isW(a, "p")) === paragraph);
		const unsupported =
			!sameParagraph ||
			ancestorsOf(paragraph).some((a) => isW(a, "txbxContent")) ||
			!touched.every((t) => plainRunText(t, paragraph));
		if (unsupported) {
			outcomes.push(failed(item.id, "unsupported", UNSUPPORTED));
			continue;
		}

		const firstT = touched[0]!;
		const lastT = touched[touched.length - 1]!;
		let firstRun = firstT.parentNode as El;
		let lastRun = lastT.parentNode as El;
		// End first: the start split may then move the trimmed run's content to its right half.
		lastRun = splitAfter(lastRun, lastT, match.end.offset);
		const singleRun = firstRun === lastRun;
		firstRun = splitBefore(firstRun, firstT, match.start.offset);
		if (singleRun) lastRun = firstRun;

		const runs: El[] = [];
		const all = paragraph.getElementsByTagNameNS(W, "r");
		let inRange = false;
		for (let i = 0; i < all.length; i++) {
			const run = all[i] as unknown as El;
			if (run === firstRun) inRange = true;
			if (inRange) runs.push(run);
			if (run === lastRun) break;
		}
		for (const run of runs) highlight(run);

		const id = String(nextId++);
		firstRun.parentNode!.insertBefore(wEl(doc, "commentRangeStart", { id }), firstRun);
		const rangeEnd = wEl(doc, "commentRangeEnd", { id });
		insertAfter(lastRun.parentNode!, rangeEnd, lastRun);
		const reference = wEl(doc, "r");
		reference.appendChild(wEl(doc, "commentReference", { id }));
		insertAfter(rangeEnd.parentNode!, reference, rangeEnd);

		const comment = wEl(comments, "comment", { id, author: AUTHOR, initials: "LH", date: isoDate });
		for (const line of item.note.split(/\r?\n/)) {
			const p = wEl(comments, "p");
			const r = wEl(comments, "r");
			const t = wEl(comments, "t");
			setText(t, line);
			r.appendChild(t);
			p.appendChild(r);
			comment.appendChild(p);
		}
		commentsRoot.appendChild(comment);
		outcomes.push({ id: item.id, result: "written" });
		written++;
	}
	if (written === 0) return { bytes: null, outcomes };

	zip.file("word/document.xml", serialize(doc, documentXml));
	zip.file(partName, serialize(comments, existingCommentsXml ?? null));
	if (!existingPart) await relateNewCommentsPart(zip, rels, relsXml);
	return { bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), outcomes };
}

/** A document with no comments part: add word/comments.xml's relationship and content type. */
async function relateNewCommentsPart(zip: JSZip, rels: Document | null, relsXml: string | undefined): Promise<void> {
	if (rels) {
		const root = rels.documentElement as El;
		const taken = new Set<string>();
		const list = rels.getElementsByTagName("Relationship");
		for (let i = 0; i < list.length; i++) taken.add(list[i]!.getAttribute("Id") ?? "");
		let relId = "rIdLhComments";
		for (let n = 2; taken.has(relId); n++) relId = `rIdLhComments${n}`;
		const rel = rels.createElementNS(root.namespaceURI, "Relationship");
		rel.setAttribute("Id", relId);
		rel.setAttribute("Type", REL_COMMENTS);
		rel.setAttribute("Target", "comments.xml");
		root.appendChild(rel);
		zip.file("word/_rels/document.xml.rels", serialize(rels, relsXml ?? null));
	}
	const typesXml = await zip.file("[Content_Types].xml")?.async("string");
	if (typesXml === undefined) return;
	const types = parseXml(typesXml);
	const overrides = types.getElementsByTagName("Override");
	for (let i = 0; i < overrides.length; i++) if (overrides[i]!.getAttribute("PartName") === "/word/comments.xml") return;
	const root = types.documentElement as El;
	const override = types.createElementNS(root.namespaceURI, "Override");
	override.setAttribute("PartName", "/word/comments.xml");
	override.setAttribute("ContentType", COMMENTS_CONTENT_TYPE);
	root.appendChild(override);
	zip.file("[Content_Types].xml", serialize(types, typesXml));
}
