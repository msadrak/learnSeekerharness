/**
 * The document viewer's server surface (routes are thin): the viewer state on
 * the chat record, opening/uploading documents, serving their bytes, and the
 * learner's decisions on the agent's annotation proposals.
 */
import * as fsp from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pdfjsDistDir } from "../agent/subagents/pdf-ops.ts";
import { writeAnnotations } from "../agent/documents/annotate.ts";
import { docxToHtml } from "../agent/documents/docx-html.ts";
import {
	addDocumentToViewer,
	DocumentAccessError,
	documentFile,
	registerPathDocument,
	registerUploadDocument,
	resolveDocumentRef,
} from "../agent/documents/registry.ts";
import {
	DOCUMENT_ID_RE,
	viewerOf,
	type ChatViewerState,
	type DocumentLocation,
	type SessionDocument,
} from "../core/documents.ts";
import { stores } from "./stores.ts";

export { DocumentAccessError };

/** An invalid request body or reference (mapped to HTTP 400 by the routes). */
export class ViewerInputError extends Error {}

const MAX_TABS = 50;
const MAX_SECTION_CHARS = 200;

function viewerOfChat(chatId: string): ChatViewerState | null {
	const chat = stores.chatStore.getChat(chatId);
	return chat ? viewerOf(chat) : null;
}

/** The chat's viewer state (empty when it never opened a document); null for an unknown chat. */
export function getViewer(chatId: string): ChatViewerState | null {
	return viewerOfChat(chatId);
}

/** PUT /viewer: replace tabs, activeId, panelVisible and positions after validating them against the registered documents. */
export function updateViewerLayout(chatId: string, body: unknown): ChatViewerState | null {
	if (typeof body !== "object" || body === null) throw new ViewerInputError("Body must be an object.");
	const b = body as Record<string, unknown>;
	if (!Array.isArray(b.tabs) || b.tabs.some((t) => typeof t !== "string")) throw new ViewerInputError("tabs must be an array of document ids.");
	const tabs = b.tabs as string[];
	if (tabs.length > MAX_TABS) throw new ViewerInputError(`At most ${MAX_TABS} tabs.`);
	if (new Set(tabs).size !== tabs.length) throw new ViewerInputError("tabs must be unique.");
	if (b.activeId !== null && typeof b.activeId !== "string") throw new ViewerInputError("activeId must be a document id or null.");
	if (typeof b.panelVisible !== "boolean") throw new ViewerInputError("panelVisible must be a boolean.");
	if (typeof b.positions !== "object" || b.positions === null || Array.isArray(b.positions)) throw new ViewerInputError("positions must be an object.");
	const activeId = b.activeId as string | null;
	if (activeId !== null && !tabs.includes(activeId)) throw new ViewerInputError("activeId must be one of tabs.");
	const positions: Record<string, DocumentLocation> = {};
	for (const [id, raw] of Object.entries(b.positions as Record<string, unknown>)) {
		if (typeof raw !== "object" || raw === null) throw new ViewerInputError("Each position must be an object.");
		const p = raw as Record<string, unknown>;
		if (p.page !== undefined && !(Number.isInteger(p.page) && (p.page as number) >= 1)) throw new ViewerInputError("position.page must be a positive integer.");
		if (p.section !== undefined && (typeof p.section !== "string" || p.section.length > MAX_SECTION_CHARS)) throw new ViewerInputError("position.section must be a short string.");
		positions[id] = {
			...(p.page !== undefined ? { page: p.page as number } : {}),
			...(p.section !== undefined ? { section: p.section as string } : {}),
		};
	}
	// Validated inside the read-modify-write so the registered set is the freshest one.
	let failure: string | null = null;
	const saved = stores.chatStore.updateViewer(chatId, (viewer) => {
		const registered = new Set(viewer.documents.map((d) => d.id));
		const unknown = [...tabs, ...Object.keys(positions)].find((id) => !registered.has(id));
		if (unknown !== undefined) {
			failure = `Unknown document: ${unknown}`;
			return viewer;
		}
		return { ...viewer, tabs, activeId, panelVisible: b.panelVisible as boolean, positions };
	});
	if (failure !== null) throw new ViewerInputError(failure);
	return saved;
}

function registerIn(chatId: string, doc: SessionDocument, addedBy: "learner" | "agent"): { viewer: ChatViewerState; documentId: string } | null {
	const viewer = stores.chatStore.updateViewer(chatId, (v) => addDocumentToViewer(v, doc, addedBy).viewer);
	return viewer ? { viewer, documentId: doc.id } : null;
}

/** POST /documents (JSON {path}): open a file by path. Null for an unknown chat. */
export async function openDocumentPath(chatId: string, rawPath: string, addedBy: "learner" | "agent" = "learner") {
	const snapshot = viewerOfChat(chatId);
	if (!snapshot) return null;
	const { doc } = await registerPathDocument(snapshot, rawPath, addedBy);
	return registerIn(chatId, doc, addedBy);
}

/** POST /documents (multipart `file`): store the upload by content hash and open it. */
export async function openUploadedDocument(chatId: string, file: File) {
	const snapshot = viewerOfChat(chatId);
	if (!snapshot) return null;
	const { doc } = await registerUploadDocument(snapshot, new Uint8Array(await file.arrayBuffer()), file.name, "learner");
	return registerIn(chatId, doc, "learner");
}

export function documentOf(chatId: string, docId: string): SessionDocument {
	const viewer = viewerOfChat(chatId);
	const doc = viewer && DOCUMENT_ID_RE.test(docId) ? resolveDocumentRef(viewer, docId) : null;
	if (!doc) throw new DocumentAccessError("Document not found.", 404);
	return doc;
}

const FILE_TYPES = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	markdown: "text/markdown; charset=utf-8",
} as const;

/** GET /documents/[docId]/file: the raw bytes, streamed. Missing file → DocumentAccessError(404, path). */
export async function documentFileResponse(chatId: string, docId: string): Promise<Response> {
	const doc = documentOf(chatId, docId);
	const file = documentFile(doc);
	let size: number;
	try {
		size = (await fsp.stat(file)).size;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new DocumentAccessError(`File not found: ${file}`, 404, file);
		throw err;
	}
	return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
		headers: {
			"Content-Type": FILE_TYPES[doc.format],
			"Content-Length": String(size),
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

/** GET /documents/[docId]/html: a Word document as sanitized semantic HTML. */
export async function documentHtmlResponse(chatId: string, docId: string): Promise<Response> {
	const doc = documentOf(chatId, docId);
	if (doc.format !== "docx") throw new DocumentAccessError("Only Word documents have an HTML view.", 400);
	const file = documentFile(doc);
	let bytes: Buffer;
	try {
		bytes = await fsp.readFile(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new DocumentAccessError(`File not found: ${file}`, 404, file);
		throw err;
	}
	let html: string;
	try {
		html = await docxToHtml(new Uint8Array(bytes));
	} catch {
		throw new DocumentAccessError("This Word document could not be read.", 400);
	}
	return Response.json({ html }, { headers: { "Cache-Control": "private, no-store" } });
}

export type AnnotationDecisionOutcome = {
	id: string;
	outcome: "accepted" | "rejected" | "failed" | "pending";
	message?: string;
};

/** Annotation ids being written right now: a double-click must not write twice. */
const writing = new Set<string>();

/** POST /annotations: reject, or write the accepted proposals into their files (one write per document). */
export async function decideAnnotations(
	chatId: string,
	ids: readonly string[],
	decision: "accept" | "reject",
): Promise<{ viewer: ChatViewerState; outcomes: AnnotationDecisionOutcome[] } | null> {
	const snapshot = viewerOfChat(chatId);
	if (!snapshot) return null;
	const wanted = new Set(ids);
	const pending = snapshot.annotations.filter((a) => wanted.has(a.id) && a.status === "pending");
	const decidedAt = new Date().toISOString();

	if (decision === "reject") {
		const rejected = new Set(pending.map((a) => a.id));
		const viewer = stores.chatStore.updateViewer(chatId, (v) => ({
			...v,
			annotations: v.annotations.map((a) =>
				rejected.has(a.id) && a.status === "pending" ? { ...a, status: "rejected" as const, decidedAt, reported: false } : a),
		}))!;
		return { viewer, outcomes: [...rejected].map((id) => ({ id, outcome: "rejected" as const })) };
	}

	const outcomes: AnnotationDecisionOutcome[] = [];
	const results = new Map<string, { status: "accepted" | "failed" | "pending"; failure?: "not-found" | "unsupported" | "encrypted"; message?: string }>();
	const claimed = pending.filter((a) => !writing.has(a.id));
	for (const a of claimed) writing.add(a.id);
	try {
		const byDocument = new Map<string, typeof claimed>();
		for (const a of claimed) byDocument.set(a.documentId, [...(byDocument.get(a.documentId) ?? []), a]);
		for (const [documentId, group] of byDocument) {
			const doc = resolveDocumentRef(snapshot, documentId);
			if (!doc) {
				for (const a of group) results.set(a.id, { status: "failed", failure: "not-found", message: "Document not found." });
				continue;
			}
			let written: Awaited<ReturnType<typeof writeAnnotations>>;
			try {
				written = await writeAnnotations(doc, group);
			} catch (err) {
				written = { transient: "error", message: err instanceof Error ? err.message : String(err) };
			}
			if ("transient" in written) {
				for (const a of group) results.set(a.id, { status: "pending", message: written.message });
				continue;
			}
			for (const o of written) {
				results.set(o.id, o.result === "written"
					? { status: "accepted" }
					: { status: "failed", failure: o.failure, message: o.message });
			}
		}
	} finally {
		for (const a of claimed) writing.delete(a.id);
	}
	const viewer = stores.chatStore.updateViewer(chatId, (v) => ({
		...v,
		annotations: v.annotations.map((a) => {
			const result = results.get(a.id);
			if (!result || a.status !== "pending") return a;
			if (result.status === "pending") return { ...a, lastError: result.message };
			const { lastError: _lastError, ...rest } = a;
			return result.status === "accepted"
				? { ...rest, status: "accepted" as const, decidedAt, reported: false }
				: { ...rest, status: "failed" as const, failure: result.failure, decidedAt, reported: false };
		}),
	}))!;
	for (const a of pending) {
		const result = results.get(a.id);
		outcomes.push(result
			? { id: a.id, outcome: result.status, ...(result.message ? { message: result.message } : {}) }
			: { id: a.id, outcome: "pending" });
	}
	return { viewer, outcomes };
}

const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];
const PDFJS_FILE = /^[A-Za-z0-9._-]+$/;

function pdfjsContentType(file: string): string {
	if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript";
	if (file.endsWith(".wasm")) return "application/wasm";
	return "application/octet-stream";
}

/** GET /pdfjs/[...path]: the viewer's pdf.js worker and assets, nothing else from the package. */
export async function pdfjsAssetResponse(segments: readonly string[]): Promise<Response> {
	const notFound = Response.json({ error: "Not found" }, { status: 404 });
	const [first, second] = segments;
	const allowed =
		segments.length === 2 &&
		second !== undefined &&
		PDFJS_FILE.test(second) &&
		((first === "build" && second === "pdf.worker.min.mjs") || (first !== undefined && PDFJS_DIRS.includes(first)));
	if (!allowed) return notFound;
	const file = path.join(pdfjsDistDir(), first!, second);
	try {
		const bytes = await fsp.readFile(file);
		return new Response(new Uint8Array(bytes), {
			headers: { "Content-Type": pdfjsContentType(second), "Cache-Control": "public, max-age=86400" },
		});
	} catch {
		return notFound;
	}
}

/** Map a viewer/document failure to its HTTP response; null when it is not ours (the caller rethrows). */
export function documentErrorResponse(err: unknown): Response | null {
	if (err instanceof DocumentAccessError) {
		const body = err.status === 404 && err.path !== undefined ? { error: "missing", path: err.path } : { error: err.message };
		return Response.json(body, { status: err.status, headers: { "Cache-Control": "no-store" } });
	}
	if (err instanceof ViewerInputError) return Response.json({ error: err.message }, { status: 400 });
	return null;
}
