import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PATHS } from "../../../config.ts";
import { MAX_DOCUMENT_BYTES } from "../../../lib/document-limits.ts";
import {
	documentFormatOf,
	type ChatViewerState,
	type DocumentSource,
	type SessionDocument,
} from "../../core/documents.ts";
import { openPdfBytes } from "../subagents/pdf-ops.ts";
import { comparisonPath } from "../tools/file-access.ts";
import { resolveSourcePath } from "../tools/fs-shared.ts";

/** Every registry/file failure: routes map `status` directly, tools surface `message`. */
export class DocumentAccessError extends Error {
	/** `path`: the file that was not found (status 404), for the viewer's own wording. */
	constructor(message: string, readonly status: 400 | 403 | 404 | 413, readonly path?: string) {
		super(message);
		this.name = "DocumentAccessError";
	}
}

const UPLOAD_EXTENSIONS = [".pdf", ".docx", ".md", ".markdown"] as const;
type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number];

const TOO_LARGE = "Documents are limited to 100 MB.";

export function documentIdFor(source: DocumentSource): string {
	const key = source.kind === "path" ? `path:${comparisonPath(source.path)}` : `upload:${source.sha256}`;
	return `doc_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

function unsupported(name: string): DocumentAccessError {
	const ext = path.extname(name) || "(none)";
	return new DocumentAccessError(`Unsupported document type: ${ext}. Only .pdf, .docx, .md and .markdown files can be opened.`, 400);
}

/** Page count of a PDF, or the "could not be read" refusal. The bytes are copied: pdfjs may detach its input. */
async function pdfPageCount(bytes: Uint8Array): Promise<number> {
	let opened: Awaited<ReturnType<typeof openPdfBytes>>;
	try {
		opened = await openPdfBytes(bytes.slice());
	} catch {
		throw new DocumentAccessError("This PDF could not be read.", 400);
	}
	try {
		return opened.doc.numPages;
	} finally {
		await opened.task.destroy();
	}
}

/** Add a document to the viewer: tab appended, active per who opened it. Pure on `viewer`
 *  (callers apply it to the freshest state after their IO, inside `updateViewer`). */
export function addDocumentToViewer(
	viewer: ChatViewerState,
	doc: SessionDocument,
	addedBy: "learner" | "agent",
): { viewer: ChatViewerState; doc: SessionDocument } {
	const existing = viewer.documents.find((d) => d.id === doc.id);
	const stored = existing ?? doc;
	return {
		doc: stored,
		viewer: {
			...viewer,
			documents: existing ? viewer.documents : [...viewer.documents, doc],
			tabs: viewer.tabs.includes(stored.id) ? viewer.tabs : [...viewer.tabs, stored.id],
			activeId: addedBy === "learner" ? stored.id : viewer.activeId ?? stored.id,
		},
	};
}

/** Register a document referenced by path (desktop files stay in place, agent paths). */
export async function registerPathDocument(
	viewer: ChatViewerState,
	rawPath: string,
	addedBy: "learner" | "agent",
	now = new Date(),
): Promise<{ viewer: ChatViewerState; doc: SessionDocument }> {
	let file: string;
	try {
		file = resolveSourcePath(rawPath);
	} catch (err) {
		throw new DocumentAccessError(err instanceof Error ? err.message : String(err), 403);
	}
	let stat: fs.Stats;
	try {
		stat = await fsp.stat(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new DocumentAccessError(`File not found: ${file}`, 404, file);
		throw new DocumentAccessError(err instanceof Error ? err.message : String(err), 400);
	}
	if (!stat.isFile()) throw new DocumentAccessError(`Not a file: ${file}`, 400);
	if (stat.size > MAX_DOCUMENT_BYTES) throw new DocumentAccessError(TOO_LARGE, 413);
	const format = documentFormatOf(file);
	if (!format) throw unsupported(file);
	const source: DocumentSource = { kind: "path", path: file };
	const id = documentIdFor(source);
	const existing = viewer.documents.find((d) => d.id === id);
	if (existing) return addDocumentToViewer(viewer, existing, addedBy);
	const pageCount = format === "pdf" ? await pdfPageCount(new Uint8Array(await fsp.readFile(file))) : undefined;
	return addDocumentToViewer(viewer, {
		id,
		name: path.basename(file),
		format,
		source,
		...(pageCount !== undefined ? { pageCount } : {}),
		addedAt: now.toISOString(),
		addedBy,
	}, addedBy);
}

function uploadExtension(name: string): UploadExtension | null {
	const lower = name.toLowerCase();
	return UPLOAD_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

/** Store uploaded bytes once per content hash: data/documents/<sha256><ext>. */
export async function storeUpload(bytes: Uint8Array, name: string): Promise<DocumentSource & { kind: "upload" }> {
	const ext = uploadExtension(name);
	if (!ext) throw unsupported(name);
	if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentAccessError(TOO_LARGE, 413);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const target = path.join(PATHS.documents, `${sha256}${ext}`);
	if (!fs.existsSync(target)) {
		fs.mkdirSync(PATHS.documents, { recursive: true });
		const temp = `${target}.tmp-${randomUUID()}`;
		try {
			await fsp.writeFile(temp, bytes);
			await fsp.rename(temp, target);
		} finally {
			await fsp.rm(temp, { force: true });
		}
	}
	return { kind: "upload", sha256, ext };
}

/** Register an uploaded document (browser-only mode). `name` is the file's own name. */
export async function registerUploadDocument(
	viewer: ChatViewerState,
	bytes: Uint8Array,
	name: string,
	addedBy: "learner" | "agent",
	now = new Date(),
): Promise<{ viewer: ChatViewerState; doc: SessionDocument }> {
	const baseName = path.posix.basename(name.replaceAll("\\", "/"));
	const format = documentFormatOf(baseName);
	if (!format) throw unsupported(baseName);
	if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentAccessError(TOO_LARGE, 413);
	// Validate before storing: an unreadable PDF must not leave a stored copy behind.
	const pageCount = format === "pdf" ? await pdfPageCount(bytes) : undefined;
	const source = await storeUpload(bytes, baseName);
	const id = documentIdFor(source);
	const existing = viewer.documents.find((d) => d.id === id);
	if (existing) return addDocumentToViewer(viewer, existing, addedBy);
	return addDocumentToViewer(viewer, {
		id,
		name: baseName,
		format,
		source,
		...(pageCount !== undefined ? { pageCount } : {}),
		addedAt: now.toISOString(),
		addedBy,
	}, addedBy);
}

/** The file a document's bytes live in. Path documents are re-guarded on every access. */
export function documentFile(doc: SessionDocument): string {
	if (doc.source.kind === "upload") return path.join(PATHS.documents, `${doc.source.sha256}${doc.source.ext}`);
	try {
		return resolveSourcePath(doc.source.path);
	} catch (err) {
		throw new DocumentAccessError(err instanceof Error ? err.message : String(err), 403);
	}
}

/** Id lookup only (paths are the caller's business). */
export function resolveDocumentRef(viewer: ChatViewerState, ref: string): SessionDocument | null {
	return viewer.documents.find((d) => d.id === ref) ?? null;
}

