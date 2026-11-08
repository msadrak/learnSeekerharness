"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { WaypointsIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { textDirection } from "@/lib/i18n/direction";
import { createNotesImportQueue, EMPTY_IMPORT_QUEUE, notesPath } from "./notes-import-queue";
import { useT, type Messages } from "@/components/i18n";
import { localizeServerError } from "@/lib/i18n/server-errors";

export { MAX_IMPORT_BYTES } from "@/lib/notes-import-limits.ts";
export { notesPath } from "./notes-import-queue";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
	notice?: string;
}

/** Contributor's strict attribution: validate the complete response before
 * applying any row, even when several files have identical basenames. */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Check the graph before retrying.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== notesPath(files[r.requestIndex]!)) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider", "notice"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) {
		form.append("files", file);
		form.append("paths", notesPath(file));
	}
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Check the graph before retrying."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}${/[.!?]$/.test(detail) ? "" : "."} Check the graph before retrying.`);
	}
	return parseNotesImportResults(body, files);
}

// Client module singleton: shared by both home views and successive selections.
// SSR never appends Files, and uses the immutable empty server snapshot.
const pageImportQueue = createNotesImportQueue(postNotesImport);
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const snapshot = useSyncExternalStore(pageImportQueue.subscribe, pageImportQueue.getSnapshot, () => EMPTY_IMPORT_QUEUE);
	const latest = useRef(callbacks);
	latest.current = callbacks;
	const seenCompletion = useRef(snapshot.completion);
	useEffect(() => {
		if (seenCompletion.current !== snapshot.completion) {
			seenCompletion.current = snapshot.completion;
			latest.current.onFinish?.();
		}
	}, [snapshot.completion]);
	return {
		errors: snapshot.errors, notices: snapshot.notices, importing: snapshot.importing,
		onImportFiles: (files: FileList | null) => {
			if (!files || files.length === 0) return;
			latest.current.onStart?.();
			pageImportQueue.append(Array.from(files));
		},
	};
}

/** PR198's shared Files / Folder native picker. Unlike the donor, it remains
 * available while work is running; later selections join the SAME queue. */
export function NotesImportControl({ importing, onImportFiles }: { importing: boolean; onImportFiles: (files: FileList | null) => void }) {
	const t = useT();
	const filesRef = useRef<HTMLInputElement>(null);
	const folderRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const hintId = useId();
	const onChange = (event: ChangeEvent<HTMLInputElement>) => {
		onImportFiles(event.target.files);
		event.target.value = "";
	};
	const choices = [[t.graph.import.files, filesRef], [t.graph.import.folder, folderRef]] as const;
	return (
		<div className="relative shrink-0 rounded-full border bg-card/85 px-1 py-[3px] shadow-soft backdrop-blur"
			onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
			onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
			<input ref={filesRef} type="file" multiple accept=".md,.markdown,.txt,.pdf" className="hidden" onChange={onChange} />
			<input ref={folderRef} type="file" {...{ webkitdirectory: "" }} className="hidden" onChange={onChange} />
			<Hint label={t.graph.import.extractIntoGraph} side="bottom">
				<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-full px-3 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
					<WaypointsIcon className="size-3" />{importing ? t.graph.import.extracting : t.graph.import.extractFiles}
				</button>
			</Hint>
			{open && (
				<div role="menu" aria-label={t.graph.import.extractIntoGraph} aria-describedby={hintId} className="absolute inset-e-0 top-full z-50 mt-1.5 w-52 rounded-xl border bg-card p-1.5 shadow-float">
					<div role="none"><p id={hintId} className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">{t.graph.import.lessonHint}</p></div>
					{choices.map(([label, input]) => <button key={label} type="button" role="menuitem" className="block w-full rounded-lg px-2.5 py-1.5 text-start text-xs transition-colors hover:bg-accent/50"
						onClick={() => { setOpen(false); input.current?.click(); }}>{label}</button>)}
				</div>
			)}
		</div>
	);
}

/** The queue and `postNotesImport` keep stable English sentinels (pure,
 *  outside `useT()`); the display maps them to the dictionary. Anything
 *  unrecognized (server-authored detail) passes through. */
export function localizeImportError(error: string, i: Messages["graph"]["import"]): string {
	const unsupported = /^([\s\S]+): Unsupported format or unsafe relative path\.$/.exec(error);
	if (unsupported) return i.unsupportedPath(unsupported[1]!);
	const tooBig = /^([\s\S]+): Too big\. Max 25 MB\.$/.exec(error);
	if (tooBig) return i.pathTooBig(tooBig[1]!);
	const match = /^(?:([\s\S]+?): )?(Invalid import response\. Check the graph before retrying\.|Import request failed \(HTTP (\d+)\)(?:: ([\s\S]*?))?\.? Check the graph before retrying\.)$/.exec(error);
	if (!match) return error;
	const [, prefix, inner, status, detail] = match;
	const text = status === undefined ? i.invalidResponse : i.requestFailed(Number(status), detail ?? "");
	if (text === inner) return error;
	return prefix === undefined ? text : `\u2068${prefix}\u2069: ${text}`;
}

/** The import queue prefixes server-authored text with the file path
 *  (`path: message`, optionally followed by a code line) and wraps a failed
 *  request's body.error inside the HTTP sentinel. Display: localize that
 *  server text first, then the client sentinels. */
function localizeImportDisplay(error: string, t: Messages): string {
	const failed = /^([\s\S]*?Import request failed \(HTTP \d+\): )([\s\S]*?)(\.?) Check the graph before retrying\.$/.exec(error);
	if (failed) {
		const [, head, detail, dot] = failed;
		for (const candidate of dot ? [`${detail}.`, detail!] : [detail!]) {
			const localized = localizeServerError(candidate, t);
			if (localized !== candidate) return localizeImportError(`${head}${localized} Check the graph before retrying.`, t.graph.import);
		}
	}
	const local = localizeImportError(error, t.graph.import);
	if (local !== error) return local;
	const [first = "", ...rest] = error.split("\n");
	const wholeLine = localizeServerError(first, t);
	if (wholeLine !== first) return [wholeLine, ...rest].join("\n");
	const prefixed = /^(.+?): (.+)$/.exec(first);
	if (prefixed) {
		const localized = localizeServerError(prefixed[2]!, t);
		if (localized !== prefixed[2]) return [`\u2068${prefixed[1]}\u2069: ${localized}`, ...rest].join("\n");
	}
	return error;
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	const t = useT();
	return <>{errors.map((error, i) => {
		const shown = localizeImportDisplay(error, t);
		return <p key={i} role="alert" dir={textDirection(shown)} className="max-w-full whitespace-pre-wrap break-words text-xs text-danger">{shown}</p>;
	})}</>;
}
export function NotesImportNotices({ notices }: { notices: readonly string[] }) {
	return <>{notices.map((notice, i) => <p key={i} role="status" dir={textDirection(notice)} className="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground">{notice}</p>)}</>;
}
