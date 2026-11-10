import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AnnotationProposalDetails, OpenDocumentDetails, PassageDetails } from "../../core/contracts.ts";
import {
	assignReadingInputSchema,
	DOCUMENT_FORMAT_LABEL,
	DOCUMENT_ID_RE,
	emptyViewer,
	MAX_ANNOTATION_NOTE_CHARS,
	viewerOf,
	type DocumentAnnotation,
	type PageRegion,
	type SessionDocument,
} from "../../core/documents.ts";
import {
	SCAN_PASSAGE_TIMEOUT_MS,
	SCAN_SECTION_MAX_TEXT_PAGES,
	SCAN_SECTION_TIMEOUT_MS,
	type ScanPassageLocator,
	type ScanSectionReader,
	type ScanSectionRequest,
	type ScanSectionResult,
} from "../../core/scan-section.ts";
import type { ChatStore } from "../../core/ports.ts";
import { checkAnnotation } from "../documents/annotate.ts";
import { addDocumentToViewer, registerPathDocument, resolveDocumentRef } from "../documents/registry.ts";
import { documentText, locateInDocument, pdfPageBlock, type DocumentText } from "../documents/text.ts";
import { parsePageSpec } from "../subagents/pdf-ops.ts";
import { invalidInputResult, serverExecute, toToolResult, type ToolExecuteContext } from "../tool-execute.ts";
import { readTextSlice } from "./read.ts";

/** What the document tools need: the chat's own record (for the viewer state). */
export interface DocumentToolContext {
	chatId: string;
	chatStore: Pick<ChatStore, "getChat" | "updateViewer">;
	/** The server's scanned-section reader (the composition root injects it; absent = read_scanned_section reports it unavailable). */
	readScannedSection?: ScanSectionReader;
	/** The server's scanned-page passage locator (injected; absent = propose_annotation cannot annotate a scanned page). */
	locateScanPassage?: ScanPassageLocator;
}

function viewerNow(ctx: DocumentToolContext) {
	const record = ctx.chatStore.getChat(ctx.chatId);
	return record ? viewerOf(record) : emptyViewer();
}

/** A `document` argument as a registered, open document: ids look up the session's documents;
 *  anything else is a path, registered (and opened as a tab) on first use. */
async function openedDocument(ctx: DocumentToolContext, ref: string): Promise<SessionDocument> {
	const viewer = viewerNow(ctx);
	if (DOCUMENT_ID_RE.test(ref)) {
		const doc = resolveDocumentRef(viewer, ref);
		if (!doc) throw new Error(`No document ${ref} in this session.`);
		ctx.chatStore.updateViewer(ctx.chatId, (v) => addDocumentToViewer(v, doc, "agent").viewer);
		return doc;
	}
	const { doc } = await registerPathDocument(viewer, ref, "agent");
	ctx.chatStore.updateViewer(ctx.chatId, (v) => addDocumentToViewer(v, doc, "agent").viewer);
	return doc;
}

/** read_document's document: an id, or a path read WITHOUT registering it. */
async function readableDocument(ctx: DocumentToolContext, ref: string): Promise<{ doc: SessionDocument; open: boolean }> {
	const viewer = viewerNow(ctx);
	if (DOCUMENT_ID_RE.test(ref)) {
		const doc = resolveDocumentRef(viewer, ref);
		if (!doc) throw new Error(`No document ${ref} in this session.`);
		return { doc, open: true };
	}
	const { doc } = await registerPathDocument(emptyViewer(), ref, "agent");
	return { doc, open: viewer.documents.some((d) => d.id === doc.id) };
}

function describeDocument(doc: SessionDocument): string {
	const pages = doc.format === "pdf" && doc.pageCount !== undefined ? `, ${doc.pageCount} pages` : "";
	return `${doc.name} (${doc.id}${pages})`;
}

function notFound(name: string, page: number | undefined, pdf: boolean, hint = ""): Error {
	return new Error(
		`Quote not found in ${name}${page !== undefined ? ` on page ${page}` : ""}. Copy the passage exactly from read_document${pdf ? "; PDF quotes must lie within one page" : ""}.${hint}`,
	);
}

function ambiguous(name: string, count: number, page: number | undefined): Error {
	return new Error(`Quote occurs ${count} times in ${name}. Quote a longer passage${page === undefined ? " or give page" : ""}.`);
}

/** Locate a quote or explain precisely why it cannot be used. */
function locateOrThrow(text: DocumentText, doc: SessionDocument, quote: string, page: number | undefined, hint = "") {
	const found = locateInDocument(text, quote, page);
	if (found.kind === "not-found") throw notFound(doc.name, page, doc.format === "pdf", hint);
	if (found.kind === "ambiguous") throw ambiguous(doc.name, found.count, page);
	return found;
}

const documentArg = Type.String({ minLength: 1, description: "A viewer document id (doc_…) or a file path" });
const pageArg = (description: string) => Type.Optional(Type.Integer({ minimum: 1, description }));

const readDocumentInput = Type.Object({
	document: documentArg,
	pages: Type.Optional(Type.String({ description: "PDF pages: \"3\", \"2-5\", \"1,4\"" })),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

function readDocumentTool(ctx: DocumentToolContext): AgentTool<typeof readDocumentInput> {
	return {
		name: "read_document",
		label: "read_document",
		description:
			"Read the text of a PDF, Word (.docx) or Markdown document: PDFs page by page under `--- Page N ---` markers, Word as Markdown, Markdown as its source. " +
			"`document` is a viewer document id (doc_…) or a file path. Optional `pages` (PDF: \"3\", \"2-5\", \"1,4\") and `offset`/`limit` (1-based line slice). " +
			"Output stops at 2000 lines / 50KB with a continuation hint. Pages without a text layer (scans) have no text: use read_scanned_section for those. Reading does not open the document in the learner's viewer.",
		parameters: readDocumentInput,
		execute: serverExecute("read_document", readDocumentInput, async ({ document, pages, offset, limit }) => {
			const { doc, open } = await readableDocument(ctx, document);
			const text = await documentText(doc);
			let body = text.text;
			let shown = text.pages;
			if (pages !== undefined && text.pages) {
				const wanted = parsePageSpec(pages, text.pages.length);
				if (wanted.length === 0) throw new Error(`No pages match "${pages}" (1–${text.pages.length}).`);
				shown = text.pages.filter((p) => wanted.includes(p.number));
				body = shown.map(pdfPageBlock).join("\n\n");
			}
			const label = DOCUMENT_FORMAT_LABEL[doc.format];
			const pageCount = text.pages ? `, ${text.pages.length} pages` : "";
			const scanned = shown?.filter((p) => p.text.trim() === "").length ?? 0;
			const scannedNote = scanned > 0 ? `\n\n[${scanned} of ${shown?.length} pages shown have no text layer (scanned). read_scanned_section reads a section of them through a vision model.]` : "";
			return `Document ${open ? doc.id : "(not open in the viewer)"} · ${doc.name} · ${label}${pageCount}\n\n${readTextSlice(body, offset, limit)}${scannedNote}`;
		}),
	};
}

const readScannedSectionInput = Type.Object({
	document: documentArg,
	topic: Type.String({ minLength: 1, maxLength: 300, description: "The section or topic to read, as the learner or the document calls it — no page numbers needed" }),
	form: Type.Union([Type.Literal("text"), Type.Literal("summary")], { description: "\"text\": the section's full verbatim text. \"summary\": a summary of the section." }),
	focus: Type.Optional(Type.String({ maxLength: 500, description: "With form \"summary\": what the summary must emphasise" })),
});

function pageRange(first: number, last: number): string {
	return first === last ? `page ${first}` : `pages ${first}–${last}`;
}

/** The tool result the agent reads for a located section. */
function formatScanSection(doc: SessionDocument, request: ScanSectionRequest, result: ScanSectionResult): string {
	if (result.kind === "not-found") return `Section "${request.topic}" was not found in ${doc.name}: ${result.note}`;
	const machineRead = "Read from the scan by a vision model — it may contain transcription errors.";
	if (result.kind === "summary") {
		const pages = result.pages.length > 0 ? pageRange(result.pages[0]!, result.pages[result.pages.length - 1]!) : "pages unknown";
		return `Summary of "${request.topic}" · ${doc.name} · ${pages}\n${machineRead}\n\n${result.summary}`;
	}
	const cut = result.continues ? `\nThe section continues past page ${result.lastPage}; it was cut at ${SCAN_SECTION_MAX_TEXT_PAGES} pages.` : "";
	const blocks = result.pages.map((p) => `--- Page ${p.number} ---\n\n${p.text.trim() === "" ? "(blank or unreadable page)" : p.text}`);
	return `Section "${result.title}" · ${doc.name} · ${pageRange(result.firstPage, result.lastPage)}\n${machineRead}${cut}\n\n${blocks.join("\n\n")}`;
}

function readScannedSectionTool(ctx: DocumentToolContext): AgentTool<typeof readScannedSectionInput> {
	return {
		name: "read_scanned_section",
		label: "read_scanned_section",
		description:
			"Read a section of a SCANNED PDF (pages with no text layer) through a vision model. Name the section or topic as the learner or the document calls it — you do not need page numbers; the reader finds the pages itself and reads only what it needs. " +
			`form "text": the section's full verbatim text (up to about ${SCAN_SECTION_MAX_TEXT_PAGES} pages; a longer section is cut with a note where it continues). form "summary": a summary of the section focused on \`focus\`, with page citations. ` +
			"The text is machine-read and may contain transcription errors. Slower than read_document: ask for one section at a time, never the whole book.",
		parameters: readScannedSectionInput,
		// Deliberately not serverExecute: its 30 s guard is far too short for locating and reading pages.
		// The turn's abort signal still cancels it, and it carries its own ceiling.
		execute: async (_toolCallId, input, signal) => {
			const { doc } = await readableDocument(ctx, input.document);
			if (doc.format !== "pdf") throw new Error("read_scanned_section works on PDF documents only.");
			if (!ctx.readScannedSection) throw new Error("Reading scanned sections is not available in this session.");
			const request: ScanSectionRequest = { topic: input.topic, form: input.form, ...(input.focus?.trim() ? { focus: input.focus.trim() } : {}) };
			const guard = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(SCAN_SECTION_TIMEOUT_MS)]);
			try {
				return toToolResult(formatScanSection(doc, request, await ctx.readScannedSection(doc, request, guard)));
			} catch (err) {
				if (guard.aborted && !signal?.aborted) {
					throw new Error(`Reading that section took longer than ${SCAN_SECTION_TIMEOUT_MS / 60_000} minutes and was stopped. Ask for a narrower topic.`);
				}
				throw err;
			}
		},
	};
}

const openDocumentInput = Type.Object({
	document: documentArg,
	page: pageArg("PDF only: the page the learner's Go prompt jumps to"),
});

function openDocumentTool(ctx: DocumentToolContext): AgentTool<typeof openDocumentInput> {
	return {
		name: "open_document",
		label: "open_document",
		description:
			"Open a PDF, Word (.docx) or Markdown file in the learner's document viewer as a tab without pointing at anything. `document`: a doc_… id or a file path. " +
			"Optional `page` (PDF) becomes the Go target. Returns the document id. His view does not move; he gets a Go prompt.",
		parameters: openDocumentInput,
		execute: serverExecute("open_document", openDocumentInput, async ({ document, page }) => {
			const doc = await openedDocument(ctx, document);
			const details: OpenDocumentDetails = {
				documentId: doc.id,
				name: doc.name,
				format: doc.format,
				...(page !== undefined && doc.format === "pdf" ? { page } : {}),
			};
			return { text: `Opened in the learner's viewer: ${describeDocument(doc)}. He sees a Go prompt; his view did not move.`, details };
		}),
	};
}

const pointToPassageInput = Type.Object({
	document: documentArg,
	quote: Type.String({ minLength: 1, description: "The passage, copied exactly from read_document" }),
	page: pageArg("PDF only: the page holding the passage; narrows the search"),
	note: Type.Optional(Type.String({ description: "One short line shown with the passage" })),
});

function pointToPassageTool(ctx: DocumentToolContext): AgentTool<typeof pointToPassageInput> {
	return {
		name: "point_to_passage",
		label: "point_to_passage",
		description:
			"Point the learner to an exact passage in a document: it is highlighted when he follows the Go prompt (his view never moves by itself). " +
			"`quote` must be copied exactly from read_document, within one page for PDFs, and long enough to be unique. `page` (PDF) narrows the search. " +
			"Optional `note`: one short line shown with the passage.",
		parameters: pointToPassageInput,
		execute: serverExecute("point_to_passage", pointToPassageInput, async ({ document, quote, page, note }) => {
			const doc = await openedDocument(ctx, document);
			const found = locateOrThrow(await documentText(doc), doc, quote, page);
			const trimmed = note?.trim();
			const details: PassageDetails = {
				documentId: doc.id,
				name: doc.name,
				format: doc.format,
				quote,
				...(found.page !== undefined ? { page: found.page } : {}),
				occurrence: found.occurrence,
				...(trimmed ? { note: trimmed } : {}),
			};
			return {
				text: `Pointed the learner to ${describeDocument({ ...doc, pageCount: undefined })}${found.page !== undefined ? `, page ${found.page}` : ""}. He sees a Go prompt; the passage is highlighted when he follows it.`,
				details,
			};
		}),
	};
}

const proposeAnnotationInput = Type.Object({
	document: documentArg,
	quote: Type.String({ minLength: 1, description: "The passage, copied exactly from read_document (on a scanned page: as read_scanned_section gave it)" }),
	page: pageArg("PDF only: the page holding the passage; narrows the search. Required for a scanned page (no text layer)"),
	note: Type.String({ minLength: 1, maxLength: MAX_ANNOTATION_NOTE_CHARS, description: "The note shown with the highlight" }),
});

function proposeAnnotationTool(ctx: DocumentToolContext): AgentTool<typeof proposeAnnotationInput> {
	return {
		name: "propose_annotation",
		label: "propose_annotation",
		description:
			"Propose a highlight with a note on an exact passage, to be written into the learner's file (PDF highlight annotation, Word comment, Markdown <mark> + footnote) only if he accepts it in the viewer. " +
			"`quote` must be copied exactly from read_document and lie within one page (PDF) or one paragraph (Word/Markdown). `note`: at most 1000 characters. " +
			"On a SCANNED PDF page (no text layer) give `page` and the quote as read_scanned_section gave it: a vision model places the highlight on the page image, and the learner sees the box before accepting. " +
			"The result only confirms the proposal; his decision reaches you later in a [Document viewer] note.",
		parameters: proposeAnnotationInput,
		// Deliberately not serverExecute: placing a passage on a scan paints the page and asks a vision model, far over its 30 s guard.
		// The turn's abort signal still cancels it, and it carries its own ceiling.
		execute: async (toolCallId, { document, quote, page, note }, signal) => {
			const guard = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(SCAN_PASSAGE_TIMEOUT_MS)]);
			try {
				const doc = await openedDocument(ctx, document);
				const text = await documentText(doc);
				const isBlank = (p: { text: string }) => p.text.trim() === "";
				const scannedPage = page !== undefined && doc.format === "pdf" && text.pages?.find((p) => p.number === page && isBlank(p)) ? page : undefined;
				let regions: PageRegion[] | undefined;
				let foundPage: number | undefined;
				if (scannedPage !== undefined) {
					if (!ctx.locateScanPassage) throw new Error("Annotating scanned pages is not available in this session.");
					regions = await ctx.locateScanPassage(doc, scannedPage, quote, guard);
					foundPage = scannedPage;
				} else {
					const scanHint = text.pages?.some(isBlank) ? " This PDF has pages without a text layer (scans); for a passage on one of those, give `page`." : "";
					foundPage = locateOrThrow(text, doc, quote, page, scanHint).page;
				}
				const id = `ann_${randomBytes(4).toString("hex")}`;
				const verdict = await checkAnnotation(doc, { id, quote, page: foundPage, note, ...(regions ? { regions } : {}) });
				if (verdict.result === "failed") throw new Error(verdict.message);
				const annotation: DocumentAnnotation = {
					id,
					documentId: doc.id,
					quote,
					...(foundPage !== undefined ? { page: foundPage } : {}),
					...(regions ? { regions } : {}),
					note,
					toolCallId,
					proposedAt: new Date().toISOString(),
					status: "pending",
					reported: false,
				};
				ctx.chatStore.updateViewer(ctx.chatId, (v) => ({ ...v, annotations: [...v.annotations, annotation] }));
				const details: AnnotationProposalDetails = {
					annotationId: id,
					documentId: doc.id,
					name: doc.name,
					format: doc.format,
					quote,
					...(foundPage !== undefined ? { page: foundPage } : {}),
					note,
				};
				const placed = regions ? ` A vision model placed the highlight on the scanned page (${regions.length} line${regions.length === 1 ? "" : "s"}); the learner sees the box and can reject it if it is off.` : "";
				return toToolResult({
					text: `Proposed annotation ${id} on ${doc.name}${foundPage !== undefined ? ` p. ${foundPage}` : ""}.${placed} Nothing is written unless the learner accepts; his decision arrives in a later [Document viewer] note.`,
					details,
				});
			} catch (err) {
				if (guard.aborted && !signal?.aborted) {
					throw new Error(`Placing that passage took longer than ${SCAN_PASSAGE_TIMEOUT_MS / 60_000} minutes and was stopped.`);
				}
				throw err;
			}
		},
	};
}

/** assign_reading: client-answered (dock-owned). Its result is the learner's
 *  completion or skip, appended as the call's tool result. */
function assignReadingTool(ctx: DocumentToolContext): AgentTool<typeof assignReadingInputSchema> {
	return {
		name: "assign_reading",
		label: "assign_reading",
		description:
			"Assign the learner a reading in a viewer document and end the turn: the dock shows the assignment with a Go to passage button; his result is {done:true, note?} when he presses Done reading, or {dismissed:true} when he skips. " +
			"`document` must be a doc_… id. Give `quote` (exact passage from read_document) and/or, for PDFs, `page` with optional `endPage`. `instruction`: what to read for.",
		parameters: assignReadingInputSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems: string[] = [];
			const viewer = viewerNow(ctx);
			const doc = DOCUMENT_ID_RE.test(input.document) ? resolveDocumentRef(viewer, input.document) : null;
			if (!doc) problems.push("assign_reading needs a document id (doc_…); open the file with open_document first.");
			if (input.quote === undefined && input.page === undefined) problems.push("assign_reading needs quote or page.");
			if (doc) {
				const isPdf = doc.format === "pdf";
				if (!isPdf && (input.page !== undefined || input.endPage !== undefined)) problems.push("page/endPage apply to PDFs only.");
				if (isPdf) {
					const last = doc.pageCount;
					for (const [label, value] of [["page", input.page], ["endPage", input.endPage]] as const) {
						if (value !== undefined && (value < 1 || (last !== undefined && value > last))) {
							problems.push(`${label} ${value} is outside the document (1–${last ?? "?"}).`);
						}
					}
					if (input.endPage !== undefined && input.page === undefined) problems.push("endPage needs page.");
					if (input.page !== undefined && input.endPage !== undefined && input.endPage < input.page) problems.push("endPage must be ≥ page.");
				}
				if (problems.length === 0 && input.quote !== undefined) {
					try {
						const text = await documentText(doc);
						const last = input.endPage ?? input.page;
						const scoped: DocumentText = isPdf && input.page !== undefined && text.pages
							? { ...text, pages: text.pages.filter((p) => p.number >= input.page! && p.number <= last!) }
							: text;
						const found = locateInDocument(scoped, input.quote, input.page);
						if (found.kind === "not-found") problems.push(notFound(doc.name, isPdf ? input.page : undefined, isPdf).message);
						else if (found.kind === "ambiguous") problems.push(ambiguous(doc.name, found.count, input.page).message);
					} catch (err) {
						problems.push(err instanceof Error ? err.message : String(err));
					}
				}
			}
			if (problems.length > 0) return invalidInputResult("assign_reading", problems);
			ctx.chatStore.updateViewer(ctx.chatId, (v) => addDocumentToViewer(v, doc!, "agent").viewer);
			return {
				content: [{
					type: "text" as const,
					text: "Reading assigned — the turn ends here; the learner's completion ({done:true, note?}) or skip ({dismissed:true}) arrives as this call's result.",
				}],
				details: null,
				terminate: true,
			};
		},
	};
}

/** The viewer toolset every conversation agent carries (always on, no settings toggle). */
export function documentTools(ctx: DocumentToolContext): Record<string, AgentTool<any>> {
	return {
		read_document: readDocumentTool(ctx),
		open_document: openDocumentTool(ctx),
		point_to_passage: pointToPassageTool(ctx),
		propose_annotation: proposeAnnotationTool(ctx),
		assign_reading: assignReadingTool(ctx),
		read_scanned_section: readScannedSectionTool(ctx),
	};
}
