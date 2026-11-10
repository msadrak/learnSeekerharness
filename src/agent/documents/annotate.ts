import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SessionDocument } from "../../core/documents.ts";
import { annotateDocx } from "./annotate-docx.ts";
import { annotateMarkdown } from "./annotate-markdown.ts";
import { annotatePdf } from "./annotate-pdf.ts";
import type { AnnotationInput, AnnotationOutcome } from "./annotation-types.ts";
import { documentFile } from "./registry.ts";

export type { AnnotationInput, AnnotationOutcome } from "./annotation-types.ts";

export type WriteAnnotationsResult = AnnotationOutcome[] | { transient: "locked" | "error"; message: string };

/** Serialize writes per file: two accepts must never interleave their read-modify-write. */
const locks = new Map<string, Promise<unknown>>();

function withFileLock<T>(file: string, run: () => Promise<T>): Promise<T> {
	const previous = locks.get(file) ?? Promise.resolve();
	const next = previous.then(run, run);
	locks.set(file, next.catch(() => undefined));
	return next;
}

const LOCKED_CODES = ["EBUSY", "EPERM", "EACCES"];

async function annotateBytes(
	doc: SessionDocument,
	bytes: Uint8Array,
	items: AnnotationInput[],
	now: Date,
): Promise<{ bytes: Uint8Array | null; outcomes: AnnotationOutcome[] }> {
	if (doc.format === "pdf") return annotatePdf(bytes, items, now);
	if (doc.format === "docx") return annotateDocx(bytes, items, now);
	const { text, outcomes } = annotateMarkdown(Buffer.from(bytes).toString("utf-8"), items);
	return { bytes: text === null ? null : new Uint8Array(Buffer.from(text, "utf-8")), outcomes };
}

/** Write the annotations into the document's real file (temp file + rename).
 *  A locked file or an IO error is transient: nothing was written, the proposals stay pending. */
export async function writeAnnotations(
	doc: SessionDocument,
	items: AnnotationInput[],
	now = new Date(),
): Promise<WriteAnnotationsResult> {
	const file = documentFile(doc);
	return withFileLock(file, async () => {
		let temp: string | undefined;
		try {
			const original = new Uint8Array(await fsp.readFile(file));
			const { bytes, outcomes } = await annotateBytes(doc, original, items, now);
			if (bytes === null) return outcomes;
			temp = `${file}.lh-tmp-${randomUUID()}`;
			await fsp.writeFile(temp, bytes);
			await fsp.rename(temp, file);
			temp = undefined;
			return outcomes;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== undefined && LOCKED_CODES.includes(code)) {
				return {
					transient: "locked" as const,
					message: doc.format === "docx"
						? "Close the file in Word and try again"
						: "The file is in use by another app. Close it and try again.",
				};
			}
			return { transient: "error" as const, message: err instanceof Error ? err.message : String(err) };
		} finally {
			if (temp !== undefined) await fsp.rm(temp, { force: true });
		}
	});
}

/** The writer's verdict on the file as it is now, without writing (immediate proposal feedback). */
export async function checkAnnotation(doc: SessionDocument, item: AnnotationInput): Promise<AnnotationOutcome> {
	const bytes = new Uint8Array(await fsp.readFile(documentFile(doc)));
	const { outcomes } = await annotateBytes(doc, bytes, [item], new Date());
	return outcomes[0]!;
}
