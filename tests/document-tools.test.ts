/**
 * The agent's document tools against real records and files: read_document,
 * open_document, point_to_passage, propose_annotation, assign_reading and
 * read_scanned_section,
 * through each conversation agent's registry. Isolated LH_DATA_DIR (the seam
 * is set before any config-loading import).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doc-tools-"));
process.env.LH_DATA_DIR = TMP;

const { chatStore } = await import("../src/store/chats.ts");
const { documentTools } = await import("../src/agent/tools/documents.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { viewerOf } = await import("../src/core/documents.ts");

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

type ToolResult = { content: { type: string; text?: string }[]; details?: unknown; isError?: boolean; terminate?: boolean };

async function call(tools: ReturnType<typeof documentTools>, name: string, input: unknown): Promise<ToolResult> {
	const tool = tools[name]!;
	return (await tool.execute(`call_${name}`, input as never, undefined as never, undefined as never)) as ToolResult;
}
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("");

function freshChat() {
	const chat = chatStore.createChat("viewer tools");
	return { chat, tools: documentTools({ chatId: chat.id, chatStore }) };
}

describe("document tools — registration", () => {
	const names = ["read_document", "open_document", "point_to_passage", "propose_annotation", "assign_reading", "read_scanned_section"];
	it("every conversation agent carries all six", () => {
		const chat = chatStore.createChat("registry");
		const prober = createProberTools({ chatId: chat.id, chatStore, jobStore: {} as never, spawn: () => {}, deliver: () => {} } as never);
		const teacher = createTeacherTools({ chatId: chat.id, chatStore, jobStore: {} as never, spawn: () => {} } as never);
		const practice = practiceTools({ chatId: chat.id, chatStore, documents: { chatId: chat.id, chatStore } });
		for (const registry of [prober, teacher, practice]) for (const name of names) assert.ok(registry[name], `${name} registered`);
	});
});

describe("read_document", () => {
	it("returns a PDF page by page under page markers, and only the asked pages", async () => {
		const { tools } = freshChat();
		const all = textOf(await call(tools, "read_document", { document: FIXTURE }));
		assert.match(all, /\(not open in the viewer\)/);
		for (const n of [1, 2, 3]) assert.match(all, new RegExp(`--- Page ${n} ---`));
		const two = textOf(await call(tools, "read_document", { document: FIXTURE, pages: "2" }));
		assert.match(two, /--- Page 2 ---/);
		assert.ok(!two.includes("--- Page 1 ---") && !two.includes("--- Page 3 ---"));
	});

	it("rejects a page selection that matches nothing", async () => {
		const { tools } = freshChat();
		await assert.rejects(() => call(tools, "read_document", { document: FIXTURE, pages: "9" }), /No pages match "9" \(1–3\)\./);
	});

	it("does not register a document it only read", async () => {
		const { chat, tools } = freshChat();
		await call(tools, "read_document", { document: FIXTURE });
		assert.equal(viewerOf(chatStore.getChat(chat.id)!).documents.length, 0);
	});
});

describe("open_document / point_to_passage", () => {
	it("opens a path as a tab without moving the learner (active stays unset only for the first open)", async () => {
		const { chat, tools } = freshChat();
		const result = await call(tools, "open_document", { document: FIXTURE, page: 2 });
		const details = result.details as { documentId: string; page?: number; format: string };
		assert.match(details.documentId, /^doc_[0-9a-f]{12}$/);
		assert.equal(details.page, 2);
		assert.match(textOf(result), /Opened in the learner's viewer: sample-3page\.pdf \(doc_[0-9a-f]{12}, 3 pages\)\. He sees a Go prompt; his view did not move\./);
		const viewer = viewerOf(chatStore.getChat(chat.id)!);
		assert.deepEqual(viewer.tabs, [details.documentId]);
		assert.equal(viewer.documents[0]!.addedBy, "agent");
		assert.equal(viewer.documents[0]!.pageCount, 3);
	});

	it("points to a passage and reports its page", async () => {
		const { tools } = freshChat();
		// Copied from what read_document returns for page 2.
		assert.match(textOf(await call(tools, "read_document", { document: FIXTURE, pages: "2" })), /force equals mass times acceleration/);
		const result = await call(tools, "point_to_passage", { document: FIXTURE, quote: "force equals mass times acceleration", note: "Look here" });
		const details = result.details as { page?: number; quote: string; note?: string; occurrence: number };
		assert.equal(details.page, 2);
		assert.equal(details.note, "Look here");
		assert.match(textOf(result), /^Pointed the learner to sample-3page\.pdf \(doc_[0-9a-f]{12}\), page 2\./);
	});

	it("explains a quote that is not in the document", async () => {
		const { tools } = freshChat();
		await assert.rejects(
			() => call(tools, "point_to_passage", { document: FIXTURE, quote: "thermodynamic equilibrium of zebras" }),
			/^Error: Quote not found in sample-3page\.pdf\. Copy the passage exactly from read_document; PDF quotes must lie within one page\./,
		);
	});

	it("refuses an unknown document id", async () => {
		const { tools } = freshChat();
		await assert.rejects(() => call(tools, "open_document", { document: "doc_000000000000" }), /No document doc_000000000000 in this session\./);
	});
});

describe("propose_annotation", () => {
	it("persists a pending proposal with the located page and writes nothing", async () => {
		const copy = path.join(TMP, "annotate-me.pdf");
		fs.copyFileSync(FIXTURE, copy);
		const before = fs.readFileSync(copy);
		const { chat, tools } = freshChat();
		const result = await call(tools, "propose_annotation", { document: copy, quote: "force equals mass", note: "Worth keeping" });
		const details = result.details as { annotationId: string; page?: number };
		assert.match(details.annotationId, /^ann_[0-9a-f]{8}$/);
		assert.equal(details.page, 2);
		const viewer = viewerOf(chatStore.getChat(chat.id)!);
		assert.equal(viewer.annotations.length, 1);
		assert.deepEqual(
			{ status: viewer.annotations[0]!.status, reported: viewer.annotations[0]!.reported, page: viewer.annotations[0]!.page },
			{ status: "pending", reported: false, page: 2 },
		);
		assert.deepEqual(fs.readFileSync(copy), before, "the file is untouched until the learner accepts");
	});

	it("refuses a passage that is not in the document", async () => {
		const { tools } = freshChat();
		await assert.rejects(() => call(tools, "propose_annotation", { document: FIXTURE, quote: "not in the file anywhere", note: "n" }), /Quote not found/);
	});
});

describe("assign_reading", () => {
	it("needs a registered document id: a path is an invalid-input result", async () => {
		const { tools } = freshChat();
		const result = await call(tools, "assign_reading", { document: FIXTURE, page: 1, instruction: "Read it" });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /needs a document id \(doc_…\)/);
	});

	it("needs a quote or a page, and keeps pages inside the document", async () => {
		const { tools } = freshChat();
		const opened = (await call(tools, "open_document", { document: FIXTURE })).details as { documentId: string };
		const neither = await call(tools, "assign_reading", { document: opened.documentId, instruction: "Read" });
		assert.match(textOf(neither), /needs quote or page/);
		const outside = await call(tools, "assign_reading", { document: opened.documentId, page: 7, instruction: "Read" });
		assert.match(textOf(outside), /page 7 is outside the document \(1–3\)/);
	});

	it("ends the turn on a valid assignment", async () => {
		const { chat, tools } = freshChat();
		const opened = (await call(tools, "open_document", { document: FIXTURE })).details as { documentId: string };
		const result = await call(tools, "assign_reading", { document: opened.documentId, page: 2, endPage: 3, instruction: "Find the definition" });
		assert.equal(result.terminate, true);
		assert.equal(result.isError, undefined);
		assert.ok(viewerOf(chatStore.getChat(chat.id)!).tabs.includes(opened.documentId));
	});
});
