/**
 * The document viewer's contracts and pure logic (browser-safe).
 *
 * The viewer is a per-session surface: PDF, Word (.docx) and Markdown files the
 * learner and the agents share. `ChatViewerState` lives on the chat record
 * (`ChatRecord.viewer`) and is the single source of truth for which documents
 * are registered, which tabs are open, where the learner is, and which
 * annotation proposals await a decision. The model-facing wordings below are
 * owner-approved; tests pin them verbatim.
 */
import { Type, type Static } from "typebox";

// ─── Formats and limits ──────────────────────────────────────────────────────

export type DocumentFormat = "pdf" | "docx" | "markdown";

export const DOCUMENT_FORMAT_LABEL: Record<DocumentFormat, "PDF" | "Word" | "Markdown"> = {
	pdf: "PDF",
	docx: "Word",
	markdown: "Markdown",
};

/** The format a file name denotes (case-insensitive extension), or null. */
export function documentFormatOf(name: string): DocumentFormat | null {
	const lower = name.toLowerCase();
	if (lower.endsWith(".pdf")) return "pdf";
	if (lower.endsWith(".docx")) return "docx";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
	return null;
}

export const DOCUMENT_ID_RE = /^doc_[0-9a-f]{12}$/;
export const SNAPSHOT_ID_RE = /^[a-f0-9]{64}$/;
export const ANNOTATION_ID_RE = /^ann_[0-9a-f]{8}$/;
export const MAX_EXCERPT_CHARS = 4000;
export const MAX_GRAPH_EXCERPT_CHARS = 100_000;
export const MAX_EXCERPTS_PER_MESSAGE = 10;
export const MAX_ANNOTATION_NOTE_CHARS = 1000;
export const MAX_READING_NOTE_CHARS = 20_000;
const MAX_SECTION_CHARS = 200;
/** Region-transcription refusal codes the client switches on (besides the shared 503 envelopes). */
export const REGION_EMPTY_CODE = "region_empty" as const;
export const REGION_NO_IMAGE_INPUT_CODE = "image_input_unsupported" as const;

// ─── Session state ───────────────────────────────────────────────────────────

export type DocumentSource =
	| { kind: "path"; path: string }
	| { kind: "upload"; sha256: string; ext: ".pdf" | ".docx" | ".md" | ".markdown" };

export interface SessionDocument {
	id: string;
	name: string;
	format: DocumentFormat;
	source: DocumentSource;
	pageCount?: number;
	addedAt: string;
	addedBy: "learner" | "agent";
}

/** Where the learner is in a document: a page (PDF) or the nearest heading (Word, Markdown). */
export interface DocumentLocation {
	page?: number;
	section?: string;
}

/** A rectangle on one PDF page, as fractions (0–1) of the page's width and height from its top-left corner. */
export interface PageRegion {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The whole displayed page as a region. */
export const WHOLE_PAGE: PageRegion = { x: 0, y: 0, w: 1, h: 1 };

/** Strict parse of a page region; null unless it is a non-empty rectangle inside the page. */
export function parsePageRegion(raw: unknown): PageRegion | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (Object.keys(o).some((k) => k !== "x" && k !== "y" && k !== "w" && k !== "h")) return null;
	const { x, y, w, h } = o;
	if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
	const [rx, ry, rw, rh] = [x, y, w, h] as number[];
	if (rx! < 0 || ry! < 0 || rw! <= 0 || rh! <= 0 || rx! + rw! > 1 + 1e-9 || ry! + rh! > 1 + 1e-9) return null;
	return { x: rx!, y: ry!, w: rw!, h: rh! };
}

/** A passage the learner selected, carried to the agent. */
export interface DocumentExcerpt {
	documentId: string;
	name: string;
	format: DocumentFormat;
	quote: string;
	page?: number;
	section?: string;
	/** Index of this passage among identical matches within its page (PDF) or document. */
	occurrence?: number;
	/** A screenshot region of a PDF page: `quote` is then its vision-model transcript. */
	region?: PageRegion;
	/** The region's crop in the chat's image snapshots (always with `region`). */
	snapshotId?: string;
	/** The learner corrected the transcript of an earlier message (only with `region`). */
	corrected?: boolean;
}

export type AnnotationFailure = "not-found" | "unsupported" | "encrypted";

export interface DocumentAnnotation {
	id: string;
	documentId: string;
	quote: string;
	page?: number;
	/** A passage on a scanned page (no text layer): where a vision model placed it, one rectangle per printed line. Always with `page`. */
	regions?: PageRegion[];
	note: string;
	toolCallId: string;
	proposedAt: string;
	status: "pending" | "accepted" | "rejected" | "failed";
	failure?: AnnotationFailure;
	/** A transient write error (locked file): the proposal stays pending. */
	lastError?: string;
	decidedAt?: string;
	/** True once the decision was delivered to the agent in a viewer note. */
	reported: boolean;
}

export interface ChatViewerState {
	documents: SessionDocument[];
	/** Open tabs, in order. Closing a tab only hides it. */
	tabs: string[];
	activeId: string | null;
	panelVisible: boolean;
	positions: Record<string, DocumentLocation>;
	annotations: DocumentAnnotation[];
	/** The last position note delivered to the agent (only changes are re-sent). */
	reportedPosition?: string;
}

export function emptyViewer(): ChatViewerState {
	return { documents: [], tabs: [], activeId: null, panelVisible: false, positions: {}, annotations: [] };
}

export function viewerOf(record: { viewer?: ChatViewerState }): ChatViewerState {
	return record.viewer ?? emptyViewer();
}

// ─── Model-facing wordings ───────────────────────────────────────────────────

/** `, page n` (PDF) | `, section "s"` (Word, Markdown) | "". */
export function documentLocus(excerpt: { format: DocumentFormat; page?: number; section?: string }): string {
	if (excerpt.format === "pdf") return excerpt.page !== undefined ? `, page ${excerpt.page}` : "";
	return excerpt.section ? `, section "${excerpt.section}"` : "";
}

function quoteBlock(quote: string): string {
	return quote.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

const REGION_NOTE = "a screenshot region read by a vision model; the text may contain transcription errors";
const REGION_CORRECTED_NOTE = "screenshot region; the learner corrected the transcription, this replaces the earlier transcript of the same region";

/** The bracketed origin of an excerpt: document, page or section, and — for a screenshot region — how its text was made. */
function excerptOrigin(e: DocumentExcerpt): string {
	const how = e.region ? ` — ${e.corrected ? REGION_CORRECTED_NOTE : REGION_NOTE}` : "";
	return `${e.name} (${e.documentId})${documentLocus(e)}${how}`;
}

/** The learner message for a selected passage (approved wordings 1–3; regions: the plan's header note). */
export function documentExcerptContent(action: "explain" | "quiz" | "quote", excerpts: readonly DocumentExcerpt[], text?: string): string {
	if (action === "quote") {
		const blocks = excerpts.map((e) => `[Quoted from the document viewer: ${excerptOrigin(e)}]\n${quoteBlock(e.quote)}`);
		return blocks.join("\n\n") + (text ? `\n\n${text}` : "");
	}
	const e = excerpts[0]!;
	const last = action === "explain" ? "Explain this passage to me." : "Quiz me on this passage to check my understanding.";
	return `[From the document viewer: ${excerptOrigin(e)}]\n${quoteBlock(e.quote)}\n\n${last}`;
}

function positionSuffix(loc: DocumentLocation | undefined, active: boolean): string {
	if (loc?.page !== undefined) return active ? ` · learner is on page ${loc.page}` : ` · last at page ${loc.page}`;
	if (loc?.section) return active ? ` · learner is at section "${loc.section}"` : ` · last at section "${loc.section}"`;
	return "";
}

/** The reading-position note shown to the agent before the learner's turn
 *  (approved wording 4); null for sessions that never registered a document. */
export function viewerPositionNote(viewer: ChatViewerState): string | null {
	if (viewer.documents.length === 0) return null;
	const entries: string[] = [];
	for (const id of viewer.tabs) {
		const doc = viewer.documents.find((d) => d.id === id);
		if (!doc) continue;
		const active = id === viewer.activeId;
		const pages = doc.format === "pdf" && doc.pageCount !== undefined ? `, ${doc.pageCount} pages` : "";
		entries.push(`- ${doc.id} · ${doc.name} (${DOCUMENT_FORMAT_LABEL[doc.format]}${pages}) · ${active ? "active" : "open tab"}${positionSuffix(viewer.positions[id], active)}`);
	}
	if (entries.length === 0) return "[Document viewer] No documents are open.";
	const header = viewer.panelVisible
		? "[Document viewer] Open documents:"
		: "[Document viewer] The viewer panel is hidden. Open documents:";
	return `${header}\n${entries.join("\n")}`;
}

function snippetOf(quote: string): string {
	const flat = quote.replace(/\s+/g, " ").trim();
	return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

const FAILURE_REASON: Record<AnnotationFailure, string> = {
	"not-found": "passage no longer in the file",
	unsupported: "this passage cannot be annotated",
	encrypted: "encrypted PDF",
};

/** Annotation decisions not yet delivered to the agent (approved wording 5). */
export function annotationDecisionNote(viewer: ChatViewerState): { text: string; ids: string[] } | null {
	const decided = viewer.annotations.filter((a) => a.status !== "pending" && !a.reported);
	if (decided.length === 0) return null;
	const lines = decided.map((a) => {
		const doc = viewer.documents.find((d) => d.id === a.documentId);
		const where = `${doc?.name ?? a.documentId}${a.page !== undefined ? ` p. ${a.page}` : ""}`;
		const quote = `"${snippetOf(a.quote)}"`;
		if (a.status === "accepted") return `- accepted ${a.id} · ${where} · ${quote} (written to the file)`;
		if (a.status === "rejected") return `- rejected ${a.id} · ${where} · ${quote}`;
		return `- not written ${a.id} · ${where} · ${quote} (${FAILURE_REASON[a.failure ?? "not-found"]})`;
	});
	return {
		text: `[Document viewer] The learner decided on your proposed annotations:\n${lines.join("\n")}`,
		ids: decided.map((a) => a.id),
	};
}

// ─── assign_reading ──────────────────────────────────────────────────────────

export const assignReadingInputSchema = Type.Object({
	document: Type.String({ minLength: 1, description: "Document id (doc_…) of an open or registered document" }),
	quote: Type.Optional(Type.String({ minLength: 1, description: "Exact passage to read, copied from read_document" })),
	page: Type.Optional(Type.Integer({ minimum: 1, description: "PDF only: first page to read, or the page holding the quote" })),
	endPage: Type.Optional(Type.Integer({ minimum: 1, description: "PDF only: last page of a page range" })),
	instruction: Type.String({ minLength: 1, description: "What to read for: one concrete thing to look for" }),
});
export type AssignReadingInput = Static<typeof assignReadingInputSchema>;

/** The learner's answer to an assigned reading: done (optionally with a note) or skipped. */
export interface ReadingAnswerData {
	kind: "reading";
	done: boolean;
	dismissed?: boolean;
	note?: string;
	answeredAt: string;
}

/** The compact result the agent sees as the assign_reading tool result. */
export function compactReadingAnswer(a: ReadingAnswerData): { done: true; note?: string } | { dismissed: true } {
	if (a.dismissed || !a.done) return { dismissed: true };
	return a.note ? { done: true, note: a.note } : { done: true };
}

const READING_KEYS: Record<string, true> = { kind: true, done: true, dismissed: true, note: true, answeredAt: true };

/** Strict parse of a reading answer; null for any other shape. */
export function parseReadingAnswer(raw: unknown): ReadingAnswerData | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (Object.keys(o).some((k) => !Object.hasOwn(READING_KEYS, k))) return null;
	if (o.kind !== "reading" || typeof o.done !== "boolean" || typeof o.answeredAt !== "string") return null;
	if (o.dismissed !== undefined && typeof o.dismissed !== "boolean") return null;
	if (o.note !== undefined && (typeof o.note !== "string" || o.note.length > MAX_READING_NOTE_CHARS)) return null;
	if (o.dismissed === true && (o.done || o.note !== undefined)) return null;
	if (!o.done && o.dismissed !== true) return null;
	return {
		kind: "reading",
		done: o.done,
		...(o.dismissed === true ? { dismissed: true } : {}),
		...(typeof o.note === "string" ? { note: o.note } : {}),
		answeredAt: o.answeredAt,
	};
}

export function dismissedReading(): ReadingAnswerData {
	return { kind: "reading", done: false, dismissed: true, answeredAt: new Date().toISOString() };
}

// ─── Input validation helpers (shared by parseChatInput and the viewer route) ─

export function isValidDocumentFormat(v: unknown): v is DocumentFormat {
	return v === "pdf" || v === "docx" || v === "markdown";
}

/** Strict parse of one learner excerpt; null when malformed. */
export function parseDocumentExcerpt(raw: unknown): DocumentExcerpt | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.documentId !== "string" || !DOCUMENT_ID_RE.test(o.documentId)) return null;
	if (typeof o.name !== "string" || o.name.length === 0) return null;
	if (!isValidDocumentFormat(o.format)) return null;
	if (typeof o.quote !== "string" || o.quote.length === 0 || o.quote.length > MAX_EXCERPT_CHARS || o.quote.trim().length === 0) return null;
	if (o.page !== undefined && !(Number.isInteger(o.page) && (o.page as number) >= 1)) return null;
	if (o.section !== undefined && (typeof o.section !== "string" || o.section.length > MAX_SECTION_CHARS)) return null;
	if (o.occurrence !== undefined && !(Number.isInteger(o.occurrence) && (o.occurrence as number) >= 0)) return null;
	let region: PageRegion | undefined;
	if (o.region !== undefined) {
		// A screenshot region: PDF page only, with its crop snapshot, never an in-text occurrence.
		const parsed = parsePageRegion(o.region);
		if (!parsed || o.format !== "pdf" || o.page === undefined || o.occurrence !== undefined) return null;
		if (typeof o.snapshotId !== "string" || !SNAPSHOT_ID_RE.test(o.snapshotId)) return null;
		region = parsed;
	} else if (o.snapshotId !== undefined || o.corrected !== undefined) {
		return null;
	}
	if (o.corrected !== undefined && o.corrected !== true) return null;
	return {
		documentId: o.documentId,
		name: o.name,
		format: o.format,
		quote: o.quote,
		...(o.page !== undefined ? { page: o.page as number } : {}),
		...(o.section !== undefined ? { section: o.section as string } : {}),
		...(o.occurrence !== undefined ? { occurrence: o.occurrence as number } : {}),
		...(region ? { region, snapshotId: o.snapshotId as string } : {}),
		...(o.corrected === true ? { corrected: true } : {}),
	};
}
