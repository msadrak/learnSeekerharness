/**
 * The learner↔agent contract of the document viewer, pure: the excerpt input
 * event, the owner-approved model-facing wordings (1–5, pinned verbatim), the
 * marker's place in the native record, and the assign_reading answer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	annotationDecisionNote,
	compactReadingAnswer,
	dismissedReading,
	emptyViewer,
	parseReadingAnswer,
	viewerPositionNote,
	type ChatViewerState,
	type DocumentAnnotation,
	type DocumentExcerpt,
	type SessionDocument,
} from "../src/core/documents.ts";
import { ChatInputError, dismissAppends, inputAppends, parseChatInput } from "../src/core/input-events.ts";
import {
	newAnswerResult,
	newDocumentViewerNote,
	nativeInputCause,
	toLlmMessages,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";

const PDF: SessionDocument = {
	id: "doc_aaaaaaaaaaaa", name: "paper.pdf", format: "pdf", source: { kind: "path", path: "/p/paper.pdf" },
	pageCount: 20, addedAt: "2026-01-01T00:00:00.000Z", addedBy: "learner",
};
const DOCX: SessionDocument = {
	id: "doc_bbbbbbbbbbbb", name: "notes.docx", format: "docx", source: { kind: "path", path: "/p/notes.docx" },
	addedAt: "2026-01-01T00:00:00.000Z", addedBy: "agent",
};
const MD: SessionDocument = {
	id: "doc_cccccccccccc", name: "readme.md", format: "markdown", source: { kind: "path", path: "/p/readme.md" },
	addedAt: "2026-01-01T00:00:00.000Z", addedBy: "agent",
};

function viewer(over: Partial<ChatViewerState> = {}): ChatViewerState {
	return { ...emptyViewer(), documents: [PDF, DOCX, MD], tabs: [PDF.id, DOCX.id], activeId: PDF.id, panelVisible: true, ...over };
}

const excerpt = (over: Partial<DocumentExcerpt> = {}): DocumentExcerpt => ({
	documentId: PDF.id, name: "paper.pdf", format: "pdf", quote: "Energy is conserved.\nAlways.", page: 12, ...over,
});

function content(message: LhMessage): string {
	return (message as LhMarkerMessage).content;
}

describe("parseChatInput — excerpt", () => {
	it("accepts explain/quiz with exactly one excerpt and no text", () => {
		const ok = parseChatInput({ type: "excerpt", action: "explain", excerpts: [excerpt()] });
		assert.equal(ok.type, "excerpt");
		assert.throws(() => parseChatInput({ type: "excerpt", action: "explain", excerpts: [excerpt(), excerpt()] }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "excerpt", action: "quiz", excerpts: [excerpt()], text: "hi" }), ChatInputError);
	});

	it("accepts 1..10 quote excerpts with optional text", () => {
		const parsed = parseChatInput({ type: "excerpt", action: "quote", excerpts: [excerpt(), excerpt({ page: 3 })], text: "why?" });
		assert.equal(parsed.type === "excerpt" && parsed.excerpts.length, 2);
		assert.throws(() => parseChatInput({ type: "excerpt", action: "quote", excerpts: [] }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "excerpt", action: "quote", excerpts: Array.from({ length: 11 }, () => excerpt()) }), ChatInputError);
	});

	it("rejects malformed excerpts", () => {
		for (const bad of [
			excerpt({ documentId: "paper" }),
			excerpt({ quote: "   " }),
			excerpt({ quote: "x".repeat(4001) }),
			excerpt({ page: 0 }),
			excerpt({ occurrence: -1 }),
			excerpt({ name: "" }),
			{ ...excerpt(), format: "txt" },
		]) {
			assert.throws(() => parseChatInput({ type: "excerpt", action: "quote", excerpts: [bad] }), ChatInputError);
		}
	});
});

describe("model-facing wordings", () => {
	const record = { messages: [] as LhMessage[], viewer: viewer() };

	it("1 · Explain", () => {
		const [marker] = inputAppends(record, { type: "excerpt", action: "explain", excerpts: [excerpt()] });
		assert.equal(content(marker!), "[From the document viewer: paper.pdf (doc_aaaaaaaaaaaa), page 12]\n> Energy is conserved.\n> Always.\n\nExplain this passage to me.");
	});

	it("2 · Quiz me", () => {
		const [marker] = inputAppends(record, { type: "excerpt", action: "quiz", excerpts: [excerpt({ documentId: DOCX.id, name: "notes.docx", format: "docx", page: undefined, section: "Results" })] });
		assert.equal(content(marker!), "[From the document viewer: notes.docx (doc_bbbbbbbbbbbb), section \"Results\"]\n> Energy is conserved.\n> Always.\n\nQuiz me on this passage to check my understanding.");
	});

	it("3 · Quote in message — one block per excerpt, then the learner's text", () => {
		const [marker] = inputAppends(record, {
			type: "excerpt", action: "quote",
			excerpts: [excerpt({ quote: "A" }), excerpt({ documentId: MD.id, name: "readme.md", format: "markdown", quote: "B", page: undefined })],
			text: "Compare these.",
		});
		assert.equal(content(marker!), "[Quoted from the document viewer: paper.pdf (doc_aaaaaaaaaaaa), page 12]\n> A\n\n[Quoted from the document viewer: readme.md (doc_cccccccccccc)]\n> B\n\nCompare these.");
	});

	it("4 · reading position", () => {
		assert.equal(viewerPositionNote(viewer({ positions: { [PDF.id]: { page: 12 }, [DOCX.id]: { section: "Intro" } } })),
			"[Document viewer] Open documents:\n- doc_aaaaaaaaaaaa · paper.pdf (PDF, 20 pages) · active · learner is on page 12\n- doc_bbbbbbbbbbbb · notes.docx (Word) · open tab · last at section \"Intro\"");
		assert.equal(viewerPositionNote(viewer({ panelVisible: false })),
			"[Document viewer] The viewer panel is hidden. Open documents:\n- doc_aaaaaaaaaaaa · paper.pdf (PDF, 20 pages) · active\n- doc_bbbbbbbbbbbb · notes.docx (Word) · open tab");
		assert.equal(viewerPositionNote(viewer({ activeId: DOCX.id, positions: { [DOCX.id]: { section: "Results" }, [PDF.id]: { page: 3 } } })),
			"[Document viewer] Open documents:\n- doc_aaaaaaaaaaaa · paper.pdf (PDF, 20 pages) · open tab · last at page 3\n- doc_bbbbbbbbbbbb · notes.docx (Word) · active · learner is at section \"Results\"");
		assert.equal(viewerPositionNote(viewer({ tabs: [], activeId: null })), "[Document viewer] No documents are open.");
		assert.equal(viewerPositionNote(emptyViewer()), null);
	});

	it("5 · annotation decisions", () => {
		const base: Omit<DocumentAnnotation, "id" | "status"> = {
			documentId: PDF.id, quote: "x".repeat(60), note: "n", toolCallId: "t", proposedAt: "2026-01-01T00:00:00.000Z", reported: false, page: 4,
		};
		const v = viewer({
			annotations: [
				{ ...base, id: "ann_00000001", status: "accepted" },
				{ ...base, id: "ann_00000002", status: "rejected", quote: "short quote", page: undefined, documentId: MD.id },
				{ ...base, id: "ann_00000003", status: "failed", failure: "unsupported", quote: "q3" },
				{ ...base, id: "ann_00000004", status: "failed", failure: "not-found", quote: "q4" },
				{ ...base, id: "ann_00000005", status: "failed", failure: "encrypted", quote: "q5" },
				{ ...base, id: "ann_00000006", status: "pending" },
				{ ...base, id: "ann_00000007", status: "accepted", reported: true },
			],
		});
		const note = annotationDecisionNote(v)!;
		assert.equal(note.text, [
			"[Document viewer] The learner decided on your proposed annotations:",
			`- accepted ann_00000001 · paper.pdf p. 4 · "${"x".repeat(40)}…" (written to the file)`,
			"- rejected ann_00000002 · readme.md · \"short quote\"",
			"- not written ann_00000003 · paper.pdf p. 4 · \"q3\" (this passage cannot be annotated)",
			"- not written ann_00000004 · paper.pdf p. 4 · \"q4\" (passage no longer in the file)",
			"- not written ann_00000005 · paper.pdf p. 4 · \"q5\" (encrypted PDF)",
		].join("\n"));
		assert.deepEqual(note.ids, ["ann_00000001", "ann_00000002", "ann_00000003", "ann_00000004", "ann_00000005"]);
		assert.equal(annotationDecisionNote(viewer()), null);
	});
});

describe("the excerpt marker in the record", () => {
	it("refuses a document the session never registered", () => {
		assert.throws(
			() => inputAppends({ messages: [], viewer: viewer() }, { type: "excerpt", action: "explain", excerpts: [excerpt({ documentId: "doc_ffffffffffff" })] }),
			/not registered in this session/,
		);
		assert.throws(() => inputAppends({ messages: [] }, { type: "excerpt", action: "explain", excerpts: [excerpt()] }), ChatInputError);
	});

	it("flattens to user text for the model, projects as a learner card, and counts as learner input", () => {
		const [marker] = inputAppends({ messages: [], viewer: viewer() }, { type: "excerpt", action: "explain", excerpts: [excerpt()] });
		const [flat] = toLlmMessages([marker!]);
		assert.equal(flat!.role, "user");
		assert.equal((flat as { content: { text: string }[] }).content[0]!.text, content(marker!));
		const projected = projectView([marker!]);
		assert.equal(projected[0]!.role, "user");
		assert.equal(projected[0]!.parts[0]!.type, "data-document-excerpt");
		assert.equal(nativeInputCause(marker as never, []), "learner");
		assert.match(sessionMarkdown([marker!], { anchors: false }), /### Learner\n\n\[From the document viewer: paper\.pdf/);
	});

	it("viewer notes reach the model but never the transcript, and are neutral", () => {
		const note = newDocumentViewerNote("position", "[Document viewer] No documents are open.");
		assert.equal(toLlmMessages([note as never])[0]!.role, "user");
		assert.deepEqual(projectView([note as never]), []);
		assert.equal(nativeInputCause(note as never, []), "neutral");
	});
});

describe("assign_reading answers", () => {
	const callMessage = (): LhMessage => ({
		id: "m_a", role: "assistant", stopReason: "toolUse", timestamp: 0, api: "faux", provider: "faux", model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [{ type: "toolCall", id: "call_r", name: "assign_reading", arguments: { document: PDF.id, page: 2, instruction: "Find the claim" } }],
	} as never);

	it("gives the agent {done:true,note?} or {dismissed:true}, and keeps the full answer in details", () => {
		const done = { kind: "reading" as const, done: true, note: "Section 2 states it", answeredAt: "2026-01-01T00:00:00.000Z" };
		const result = newAnswerResult("call_r", "assign_reading", done);
		assert.equal((result.content[0] as { text: string }).text, JSON.stringify({ done: true, note: "Section 2 states it" }));
		assert.deepEqual(result.details, done);
		assert.equal((newAnswerResult("call_r", "assign_reading", { ...done, note: undefined }).content[0] as { text: string }).text, "{\"done\":true}");
		assert.equal((newAnswerResult("call_r", "assign_reading", dismissedReading()).content[0] as { text: string }).text, "{\"dismissed\":true}");
		assert.deepEqual(compactReadingAnswer(dismissedReading()), { dismissed: true });
		assert.equal(nativeInputCause(result as never, [callMessage() as never]), "learner");
		assert.equal(nativeInputCause(newAnswerResult("call_r", "assign_reading", dismissedReading()) as never, [callMessage() as never]), "neutral");
	});

	it("validates the answer event against the pending tool", () => {
		const messages = [callMessage()];
		const done = { kind: "reading" as const, done: true, answeredAt: "2026-01-01T00:00:00.000Z" };
		assert.equal(inputAppends({ messages }, { type: "answer", toolCallId: "call_r", answer: done })[0]!.role, "toolResult");
		assert.throws(() => inputAppends({ messages }, { type: "answer", toolCallId: "call_r", answer: dismissedReading() }), /not a reading completion/);
		assert.throws(() => inputAppends({ messages }, { type: "answer", toolCallId: "call_r", answer: { kind: "quiz" } as never }), ChatInputError);
		assert.equal(parseReadingAnswer({ ...done, extra: 1 }), null);
	});

	it("only a reading dismissal dismisses an assignment", () => {
		const messages = [callMessage()];
		assert.equal(dismissAppends({ messages }, { type: "dismiss", toolCallId: "call_r", answer: dismissedReading() })[0]!.role, "toolResult");
		assert.throws(
			() => dismissAppends({ messages }, { type: "dismiss", toolCallId: "call_r", answer: { kind: "quiz", dismissed: true } as never }),
			/reading dismissal/,
		);
	});
});
