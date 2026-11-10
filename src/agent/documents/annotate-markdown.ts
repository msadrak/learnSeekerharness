import { locateAll } from "../../core/document-locate.ts";
import { AUTHOR, failed, type AnnotationInput, type AnnotationOutcome } from "./annotation-types.ts";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Per line: is it part of a fenced code block (fence lines included)? */
function fencedLines(lines: readonly string[]): boolean[] {
	const inside: boolean[] = [];
	let fence: { char: string; length: number } | null = null;
	for (const line of lines) {
		const trimmed = line.replace(/\r$/, "");
		if (fence === null) {
			const open = FENCE_OPEN.exec(trimmed);
			if (open) {
				fence = { char: open[1]![0]!, length: open[1]!.length };
				inside.push(true);
			} else {
				inside.push(false);
			}
		} else {
			inside.push(true);
			const close = new RegExp(`^ {0,3}\\${fence.char}{${fence.length},}\\s*$`).exec(trimmed);
			if (close) fence = null;
		}
	}
	return inside;
}

/** Wrap each passage in `<mark>…</mark>[^lh-N]` and append the `[^lh-N]: note (LearnHarness)`
 *  footnotes. BOM and EOL style are preserved; `text` is null when nothing was written. */
export function annotateMarkdown(
	text: string,
	items: readonly AnnotationInput[],
): { text: string | null; outcomes: AnnotationOutcome[] } {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split("\n"); // a trailing "\r" stays on its line: it is not a letter, so matching ignores it
	const lineStart: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineStart.push(offset);
		offset += line.length + 1;
	}
	const fenced = fencedLines(lines);
	let nextNumber = 1 + Math.max(0, ...[...text.matchAll(/\[\^lh-(\d+)\]/g)].map((m) => Number(m[1])));
	const outcomes: AnnotationOutcome[] = [];
	const edits: { start: number; end: number; number: number; note: string }[] = [];

	for (const item of items) {
		const match = locateAll(lines, item.quote)[0];
		if (!match) {
			outcomes.push(failed(item.id, "not-found", "Passage not found in the file"));
			continue;
		}
		const from = match.start.segment;
		const to = match.end.segment;
		let supported = true;
		for (let line = from; line <= to; line++) {
			// One block: no blank line inside the range, and never inside a code fence.
			if (fenced[line] || lines[line]!.trim() === "") supported = false;
		}
		const start = lineStart[from]! + match.start.offset;
		const end = lineStart[to]! + match.end.offset;
		if (!supported || edits.some((e) => start < e.end && end > e.start)) {
			outcomes.push(failed(item.id, "unsupported", "This passage can’t be annotated"));
			continue;
		}
		edits.push({ start, end, number: nextNumber++, note: item.note.replace(/\s*\r?\n\s*/g, " ").trim() });
		outcomes.push({ id: item.id, result: "written" });
	}
	if (edits.length === 0) return { text: null, outcomes };

	let out = text;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		out = `${out.slice(0, edit.start)}<mark>${out.slice(edit.start, edit.end)}</mark>[^lh-${edit.number}]${out.slice(edit.end)}`;
	}
	if (!out.endsWith("\n")) out += eol;
	for (const edit of edits) out += `${eol}[^lh-${edit.number}]: ${edit.note} (${AUTHOR})${eol}`;
	return { text: out, outcomes };
}
