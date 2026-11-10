/**
 * The document viewer's notes to the agent: where the learner is reading and
 * which annotation proposals he decided. Model-visible scaffolding appended with
 * the learner's input (never rendered). Both notes are delta-only: the position
 * note is re-sent only when its text changed, decisions only once.
 */
import type { ChatInput } from "../core/input-events.ts";
import {
	annotationDecisionNote,
	viewerOf,
	viewerPositionNote,
	type ChatViewerState,
} from "../core/documents.ts";
import { newDocumentViewerNote, type LhMessage } from "../core/native-messages.ts";
import type { ChatStore } from "../core/ports.ts";

/** Input types that begin a learner-driven turn (answers, thinking, text, excerpts, next). */
const NOTED_INPUTS: readonly string[] = ["text", "excerpt", "answer", "thinking", "next"];

export interface ViewerNotes {
	notes: LhMessage[];
	/** The position note's text (null when the session never registered a document). */
	position: string | null;
	/** Annotation ids whose decisions the notes carry. */
	decidedIds: string[];
}

export function viewerNotesFor(record: { viewer?: ChatViewerState }, input: { type: string } | ChatInput): ViewerNotes {
	if (!NOTED_INPUTS.includes(input.type)) return { notes: [], position: null, decidedIds: [] };
	const viewer = viewerOf(record);
	const position = viewerPositionNote(viewer);
	const decisions = annotationDecisionNote(viewer);
	const notes: LhMessage[] = [];
	if (position !== null && position !== viewer.reportedPosition) notes.push(newDocumentViewerNote("position", position) as LhMessage);
	if (decisions) notes.push(newDocumentViewerNote("decisions", decisions.text) as LhMessage);
	return { notes, position, decidedIds: decisions?.ids ?? [] };
}

/** A tool result must stay adjacent to its calling assistant message; every other append follows the notes. */
export function withViewerNotes(appends: readonly LhMessage[], notes: readonly LhMessage[]): LhMessage[] {
	if (notes.length === 0) return [...appends];
	return appends[0]?.role === "toolResult" ? [...appends, ...notes] : [...notes, ...appends];
}

/** Mark what the turn just delivered as reported. A failure only re-sends the note next turn. */
export function markViewerNotesReported(chatStore: Pick<ChatStore, "updateViewer">, chatId: string, delivered: ViewerNotes): void {
	if (delivered.position === null && delivered.decidedIds.length === 0) return;
	try {
		chatStore.updateViewer(chatId, (v) => ({
			...v,
			reportedPosition: delivered.position ?? v.reportedPosition,
			annotations: v.annotations.map((a) => (delivered.decidedIds.includes(a.id) ? { ...a, reported: true } : a)),
		}));
	} catch (err) {
		console.error(`[chat ${chatId}] viewer note bookkeeping failed:`, err);
	}
}
