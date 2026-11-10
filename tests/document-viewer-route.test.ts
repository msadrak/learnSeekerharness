/**
 * The viewer's HTTP surface and its turn integration, driven through the real
 * route handlers and the real chat handler (scripted faux engine, zero
 * tokens) under an isolated LH_DATA_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doc-routes-"));
process.env.LH_DATA_DIR = TMP;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { PATHS } = await import("../config.ts");
const { viewerOf } = await import("../src/core/documents.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { createTeacherTools } = await import("../src/agent/tools.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { viewerNotesFor, withViewerNotes } = await import("../src/server/viewer-notes.ts");
const { newAnswerResult, newDocumentViewerNote } = await import("../src/core/native-messages.ts");
const viewerRoute = await import("../app/api/chats/[id]/viewer/route.ts");
const documentsRoute = await import("../app/api/chats/[id]/documents/route.ts");
const fileRoute = await import("../app/api/chats/[id]/documents/[docId]/file/route.ts");
const annotationsRoute = await import("../app/api/chats/[id]/annotations/route.ts");
const pdfjsRoute = await import("../app/pdfjs/[...path]/route.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

const ctx = <E extends Record<string, string> = Record<never, never>>(id: string, extra?: E) => ({ params: Promise.resolve({ id, ...extra } as { id: string } & E) });
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function newChat() {
	const chat = chatStore.createChat("viewer routes");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

async function openPath(chatId: string, file: string): Promise<Response> {
	return documentsRoute.POST(new Request("http://test/documents", json({ path: file })), ctx(chatId));
}

function write(name: string, content: string | Buffer): string {
	const file = path.join(TMP, name);
	fs.writeFileSync(file, content);
	return file;
}

describe("viewer state", () => {
	it("updateViewer never touches updatedAt and returns null for an unknown chat", () => {
		const chat = newChat();
		const before = chatStore.getChat(chat.id)!.updatedAt;
		const saved = chatStore.updateViewer(chat.id, (v) => ({ ...v, panelVisible: true }));
		assert.equal(saved?.panelVisible, true);
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, before);
		assert.equal(chatStore.updateViewer("chat_missing", (v) => v), null);
		assert.ok(!("viewer" in (chatStore.listChats().find((c) => c.id === chat.id) ?? {})), "the list payload carries no viewer state");
	});

	it("PUT replaces the layout only for registered documents", async () => {
		const chat = newChat();
		const md = write("a.md", "# A\n\nhello\n");
		const opened = await (await openPath(chat.id, md)).json() as { documentId: string };
		const put = (body: unknown) => viewerRoute.PUT(new Request("http://test/viewer", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ctx(chat.id));
		const ok = await put({ tabs: [opened.documentId], activeId: opened.documentId, panelVisible: true, positions: { [opened.documentId]: { section: "A" } } });
		assert.equal(ok.status, 200);
		assert.deepEqual(viewerOf(chatStore.getChat(chat.id)!).positions, { [opened.documentId]: { section: "A" } });
		for (const bad of [
			{ tabs: ["doc_000000000000"], activeId: null, panelVisible: true, positions: {} },
			{ tabs: [opened.documentId, opened.documentId], activeId: null, panelVisible: true, positions: {} },
			{ tabs: [opened.documentId], activeId: "doc_000000000000", panelVisible: true, positions: {} },
			{ tabs: [opened.documentId], activeId: null, panelVisible: true, positions: { [opened.documentId]: { page: 0 } } },
			{ tabs: [], activeId: null, panelVisible: "yes", positions: {} },
		]) assert.equal((await put(bad)).status, 400);
	});

	it("GET on an unknown chat is a 404", async () => {
		assert.equal((await viewerRoute.GET(new Request("http://test/viewer"), ctx("chat_missing"))).status, 404);
	});
});

describe("opening documents", () => {
	it("refuses a dotenv file with the guard's message and an unsupported type with a 400", async () => {
		const chat = newChat();
		const env = await openPath(chat.id, write(".env", "SECRET=1\n"));
		assert.equal(env.status, 403);
		assert.match(((await env.json()) as { error: string }).error, /\S/);
		const txt = await openPath(chat.id, write("notes.txt", "plain"));
		assert.equal(txt.status, 400);
		assert.match(((await txt.json()) as { error: string }).error, /Unsupported document type: \.txt\. Only \.pdf, \.docx, \.md and \.markdown files can be opened\./);
		const gone = await openPath(chat.id, path.join(TMP, "gone.md"));
		assert.equal(gone.status, 404);
		assert.equal(((await gone.json()) as { error: string }).error, "missing");
		assert.equal(viewerOf(chatStore.getChat(chat.id)!).documents.length, 0);
	});

	it("a learner open makes the document active and keeps it in place by path", async () => {
		const chat = newChat();
		const file = write("lesson.md", "# Lesson\n\nText.\n");
		const { documentId } = await (await openPath(chat.id, file)).json() as { documentId: string };
		const viewer = viewerOf(chatStore.getChat(chat.id)!);
		assert.equal(viewer.activeId, documentId);
		assert.equal(viewer.documents[0]!.source.kind, "path");
		const raw = await fileRoute.GET(new Request("http://test/file"), ctx(chat.id, { docId: documentId }));
		assert.equal(raw.headers.get("content-type"), "text/markdown; charset=utf-8");
		assert.equal(await raw.text(), "# Lesson\n\nText.\n");
	});

	it("an upload is stored once per content hash and served back", async () => {
		const chat = newChat();
		const upload = async () => {
			const form = new FormData();
			form.set("file", new File(["# Uploaded\n"], "up.md", { type: "text/markdown" }));
			return documentsRoute.POST(new Request("http://test/documents", { method: "POST", body: form }), ctx(chat.id));
		};
		const first = await (await upload()).json() as { documentId: string };
		const second = await (await upload()).json() as { documentId: string };
		assert.equal(first.documentId, second.documentId);
		const stored = fs.readdirSync(PATHS.documents);
		assert.equal(stored.filter((f) => f.endsWith(".md")).length, 1);
		const viewer = viewerOf(chatStore.getChat(chat.id)!);
		assert.equal(viewer.documents.length, 1);
		assert.equal(viewer.documents[0]!.source.kind, "upload");
		const bad = new FormData();
		bad.set("file", new File(["x"], "x.txt"));
		const refused = await documentsRoute.POST(new Request("http://test/documents", { method: "POST", body: bad }), ctx(chat.id));
		assert.equal(refused.status, 400);
	});

	it("serves only the allow-listed pdf.js assets", async () => {
		const get = (...segments: string[]) => pdfjsRoute.GET(new Request("http://test/pdfjs"), { params: Promise.resolve({ path: segments }) });
		assert.equal((await get("build", "pdf.worker.min.mjs")).status, 200);
		assert.equal((await get("build", "pdf.min.mjs")).status, 404);
		assert.equal((await get("..", "package.json")).status, 404);
		assert.equal((await get("cmaps", "..%2Fpackage.json")).status, 404);
	});
});

describe("annotation decisions", () => {
	async function proposal() {
		const chat = newChat();
		const file = write(`ann-${Date.now()}.md`, "# Title\n\nEnergy is conserved in a closed system.\n");
		const { documentId } = await (await openPath(chat.id, file)).json() as { documentId: string };
		chatStore.updateViewer(chat.id, (v) => ({
			...v,
			annotations: [{
				id: "ann_aaaaaaa1", documentId, quote: "conserved in a closed system", note: "Key", toolCallId: "t1",
				proposedAt: new Date().toISOString(), status: "pending", reported: false,
			}],
		}));
		return { chat, file, documentId };
	}
	const decide = (chatId: string, decision: string) =>
		annotationsRoute.POST(new Request("http://test/annotations", json({ decision, ids: ["ann_aaaaaaa1"] })), ctx(chatId));

	it("accept writes into the real file and marks the proposal accepted and unreported", async () => {
		const { chat, file } = await proposal();
		const res = await decide(chat.id, "accept");
		const body = await res.json() as { outcomes: { id: string; outcome: string }[] };
		assert.deepEqual(body.outcomes, [{ id: "ann_aaaaaaa1", outcome: "accepted" }]);
		assert.match(fs.readFileSync(file, "utf-8"), /<mark>conserved in a closed system<\/mark>\[\^lh-1\]/);
		const a = viewerOf(chatStore.getChat(chat.id)!).annotations[0]!;
		assert.deepEqual({ status: a.status, reported: a.reported }, { status: "accepted", reported: false });
		// a second accept of the same proposal is ignored (it is no longer pending)
		const again = await (await decide(chat.id, "accept")).json() as { outcomes: unknown[] };
		assert.deepEqual(again.outcomes, []);
		assert.equal((fs.readFileSync(file, "utf-8").match(/<mark>/g) ?? []).length, 1);
	});

	it("reject writes nothing; an edited-away passage fails without touching the file", async () => {
		const rejected = await proposal();
		await decide(rejected.chat.id, "reject");
		assert.equal(viewerOf(chatStore.getChat(rejected.chat.id)!).annotations[0]!.status, "rejected");
		assert.ok(!fs.readFileSync(rejected.file, "utf-8").includes("<mark>"));

		const stale = await proposal();
		fs.writeFileSync(stale.file, "# Title\n\nSomething else entirely.\n");
		const res = await (await decide(stale.chat.id, "accept")).json() as { outcomes: { outcome: string; message?: string }[] };
		assert.equal(res.outcomes[0]!.outcome, "failed");
		const a = viewerOf(chatStore.getChat(stale.chat.id)!).annotations[0]!;
		assert.deepEqual({ status: a.status, failure: a.failure }, { status: "failed", failure: "not-found" });
		assert.equal(fs.readFileSync(stale.file, "utf-8"), "# Title\n\nSomething else entirely.\n");
	});

	it("validates the request body", async () => {
		const chat = newChat();
		for (const body of [{ decision: "maybe", ids: ["ann_aaaaaaa1"] }, { decision: "accept", ids: [] }, { decision: "accept", ids: ["nope"] }]) {
			assert.equal((await annotationsRoute.POST(new Request("http://test/annotations", json(body)), ctx(chat.id))).status, 400);
		}
	});
});

describe("viewer notes in the turn", () => {
	it("deliver the position and decisions once, before the learner's input", () => {
		const viewer = {
			...viewerOf({}),
			documents: [{ id: "doc_aaaaaaaaaaaa", name: "p.pdf", format: "pdf" as const, source: { kind: "path" as const, path: "/p.pdf" }, pageCount: 3, addedAt: "t", addedBy: "learner" as const }],
			tabs: ["doc_aaaaaaaaaaaa"], activeId: "doc_aaaaaaaaaaaa", panelVisible: true,
			positions: { doc_aaaaaaaaaaaa: { page: 2 } },
		};
		const first = viewerNotesFor({ viewer }, { type: "text" });
		assert.equal(first.notes.length, 1);
		const delivered = viewerNotesFor({ viewer: { ...viewer, reportedPosition: first.position! } }, { type: "text" });
		assert.equal(delivered.notes.length, 0, "an unchanged position is not re-sent");
		assert.equal(viewerNotesFor({ viewer }, { type: "steers" }).notes.length, 0, "automatic wakes carry no learner-viewer notes");
		assert.equal(viewerNotesFor({ viewer }, { type: "continue" }).notes.length, 0);
	});

	it("never separate a tool result from its calling assistant message", () => {
		const note = newDocumentViewerNote("position", "n");
		const result = newAnswerResult("c", "assign_reading", { kind: "reading", done: true, answeredAt: "t" });
		const user = { id: "u", role: "user", content: "hi", timestamp: 0 } as never;
		assert.deepEqual(withViewerNotes([result as never], [note as never]).map((m) => m.role), ["toolResult", "custom"]);
		assert.deepEqual(withViewerNotes([user], [note as never]).map((m) => m.role), ["custom", "user"]);
	});

	it("a scripted turn: the excerpt follows the position note, the agent points, and the record keeps the passage", async () => {
		const chat = newChat();
		const file = write("turn.md", "# Energy\n\nThe total energy of an isolated system stays constant over time.\n");
		const { documentId } = await (await openPath(chat.id, file)).json() as { documentId: string };
		chatStore.updateViewer(chat.id, (v) => ({ ...v, panelVisible: true, positions: { [documentId]: { section: "Energy" } } }));

		const seen: string[][] = [];
		const faux = createFauxCore({});
		faux.setResponses([
			(context) => {
				seen.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage([fauxToolCall("point_to_passage", { document: documentId, quote: "total energy of an isolated system stays constant" }, { id: "call-p" })], { stopReason: "toolUse" });
			},
			() => fauxAssistantMessage([fauxText("That is the passage.")]),
		]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const tools = createTeacherTools({ chatId: chat.id, chatStore, jobStore, spawn: () => {} });
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages, tools });
		const send = async (input: unknown) => {
			const req = new Request("http://test/api/chat", json({ chatId: chat.id, input }));
			const ack = await handleChatRequest(req, factory);
			assert.equal(ack.status, 200);
			const handle = runningTurn(chat.id);
			if (handle) await new Response(handle.subscribe()).text();
		};
		await send({
			type: "excerpt", action: "explain",
			excerpts: [{ documentId, name: "turn.md", format: "markdown", quote: "total energy of an isolated system stays constant", section: "Energy" }],
		});

		const record = chatStore.getChat(chat.id)!;
		const roles = record.messages.map((m) => m.role === "custom" ? (m as { customType: string }).customType : m.role);
		assert.deepEqual(roles.slice(0, 2), ["document-viewer", "document-excerpt"], "the note precedes the learner's excerpt");
		assert.match(seen[0]!.join("\n"), /\[Document viewer\] Open documents:/);
		assert.match(seen[0]!.join("\n"), /learner is at section \\"Energy\\"/);
		assert.equal(viewerOf(record).reportedPosition?.startsWith("[Document viewer] Open documents:"), true);
		const pointed = record.messages.find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "point_to_passage") as { details?: { documentId: string; quote: string; occurrence: number } };
		assert.equal(pointed.details?.documentId, documentId);
		assert.equal(pointed.details?.occurrence, 0);

		// Unchanged position: a second turn carries no new position note.
		faux.setResponses([() => fauxAssistantMessage([fauxText("Anything else?")])]);
		await send({ type: "text", text: "thanks" });
		const notes = chatStore.getChat(chat.id)!.messages.filter((m) => m.role === "custom" && (m as { customType: string }).customType === "document-viewer");
		assert.equal(notes.length, 1);
	});
});
