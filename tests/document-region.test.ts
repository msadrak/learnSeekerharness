/**
 * Screenshot regions of scanned PDFs: the excerpt contract (strict parse, the
 * model-facing wording), the page-fraction geometry, and the server path
 * (native crop → scan-reader model → snapshot + usage log) driven with a
 * scripted faux engine and no tokens, under an isolated LH_DATA_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { DocumentExcerpt } from "../src/core/documents.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-doc-region-"));
process.env.LH_DATA_DIR = TMP;

const { createFauxCore, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
const { chatStore } = await import("../src/store/chats.ts");
const {
	documentExcerptContent,
	parseDocumentExcerpt,
	parsePageRegion,
	REGION_EMPTY_CODE,
	REGION_NO_IMAGE_INPUT_CODE,
} = await import("../src/core/documents.ts");
const { inputAppends, ChatInputError } = await import("../src/core/input-events.ts");
const { MODELS_NOT_CONFIGURED_CODE } = await import("../src/core/settings.ts");
const { boxOfRegion, clampBox, isUsableRegion, MIN_REGION_PX, pointInPage, spanBetween } = await import("../components/document-viewer/region-geometry.ts");
const { renderPdfRegion } = await import("../src/agent/subagents/headless.ts");
const { openDocumentPath } = await import("../src/server/documents.ts");
const { RegionError, transcribeRegion } = await import("../src/server/regions.ts");
const route = await import("../app/api/chats/[id]/documents/[docId]/region/route.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

const SNAPSHOT = "a".repeat(64);
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const regionExcerpt = (over: Partial<DocumentExcerpt> = {}): DocumentExcerpt => ({
	documentId: "doc_0123456789ab",
	name: "scan.pdf",
	format: "pdf",
	quote: "Energy is conserved.",
	page: 3,
	region: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
	snapshotId: SNAPSHOT,
	...over,
});

describe("page regions and region excerpts", () => {
	it("accepts rectangles inside the page and nothing else", () => {
		assert.deepEqual(parsePageRegion(FULL), FULL);
		assert.deepEqual(parsePageRegion({ x: 0.25, y: 0.5, w: 0.75, h: 0.5 }), { x: 0.25, y: 0.5, w: 0.75, h: 0.5 });
		for (const bad of [
			{ x: 0, y: 0, w: 0, h: 1 },
			{ x: 0, y: 0, w: 1, h: -0.1 },
			{ x: -0.01, y: 0, w: 1, h: 1 },
			{ x: 0.5, y: 0, w: 0.6, h: 1 },
			{ x: 0, y: 0.9, w: 1, h: 0.2 },
			{ x: 0, y: 0, w: 1, h: 1, extra: 1 },
			{ x: Number.NaN, y: 0, w: 1, h: 1 },
			{ x: "0", y: 0, w: 1, h: 1 },
			[0, 0, 1, 1],
			null,
		]) assert.equal(parsePageRegion(bad), null, JSON.stringify(bad));
	});

	it("parses a region excerpt only as a complete PDF-page unit", () => {
		const ok = regionExcerpt({ corrected: true });
		assert.deepEqual(parseDocumentExcerpt(ok), ok);
		assert.equal(parseDocumentExcerpt(regionExcerpt({ format: "docx" })), null, "regions are PDF only");
		assert.equal(parseDocumentExcerpt(regionExcerpt({ page: undefined })), null, "a region needs its page");
		assert.equal(parseDocumentExcerpt(regionExcerpt({ snapshotId: undefined })), null, "a region needs its crop");
		assert.equal(parseDocumentExcerpt(regionExcerpt({ snapshotId: "not-a-hash" })), null);
		assert.equal(parseDocumentExcerpt(regionExcerpt({ occurrence: 0 })), null, "a region has no in-text occurrence");
		assert.equal(parseDocumentExcerpt(regionExcerpt({ region: { x: 0.9, y: 0, w: 0.5, h: 1 } })), null);
		const { region: _region, ...plain } = regionExcerpt();
		assert.equal(parseDocumentExcerpt(plain), null, "a crop id without a region");
		const { snapshotId: _snapshot, region: _r, ...bare } = regionExcerpt({ corrected: true });
		assert.equal(parseDocumentExcerpt(bare), null, "corrected without a region");
		assert.equal(parseDocumentExcerpt(regionExcerpt({ corrected: false as unknown as true })), null);
	});

	it("tells the model how the text was made, in the approved header (plain, corrected, quoted)", () => {
		const header = "[From the document viewer: scan.pdf (doc_0123456789ab), page 3 — a screenshot region read by a vision model; the text may contain transcription errors]";
		assert.equal(
			documentExcerptContent("explain", [regionExcerpt()]),
			`${header}\n> Energy is conserved.\n\nExplain this passage to me.`,
		);
		assert.equal(
			documentExcerptContent("quiz", [regionExcerpt({ corrected: true })]),
			"[From the document viewer: scan.pdf (doc_0123456789ab), page 3 — screenshot region; the learner corrected the transcription, this replaces the earlier transcript of the same region]\n> Energy is conserved.\n\nQuiz me on this passage to check my understanding.",
		);
		assert.equal(
			documentExcerptContent("quote", [regionExcerpt()], "why?"),
			`[Quoted from the document viewer: scan.pdf (doc_0123456789ab), page 3 — a screenshot region read by a vision model; the text may contain transcription errors]\n> Energy is conserved.\n\nwhy?`,
		);
		// A text excerpt keeps its wording unchanged.
		const { region: _r, snapshotId: _s, ...text } = regionExcerpt();
		assert.equal(documentExcerptContent("explain", [text]), "[From the document viewer: scan.pdf (doc_0123456789ab), page 3]\n> Energy is conserved.\n\nExplain this passage to me.");
	});

	it("refuses an excerpt whose crop is not stored in the session", () => {
		const record = { messages: [], viewer: { documents: [{ id: "doc_0123456789ab", name: "scan.pdf", format: "pdf" as const, source: { kind: "path" as const, path: "/x.pdf" }, addedAt: "x", addedBy: "learner" as const }], tabs: [], activeId: null, panelVisible: false, positions: {}, annotations: [] } };
		const input = { type: "excerpt" as const, action: "explain" as const, excerpts: [regionExcerpt()] };
		assert.throws(() => inputAppends(record, input), (err: unknown) => err instanceof ChatInputError && /not stored/.test(err.message));
		const stored = { ...record, imageSnapshots: { [SNAPSHOT]: {} } };
		assert.equal(inputAppends(stored, input).length, 1);
	});
});

describe("region geometry", () => {
	const page = { left: 100, top: 50, width: 400, height: 600 };

	it("maps drags to page fractions in either corner order, clamped to the page", () => {
		assert.deepEqual(pointInPage(page, { x: 300, y: 350 }), { x: 0.5, y: 0.5 });
		assert.deepEqual(pointInPage(page, { x: 0, y: 9999 }), { x: 0, y: 1 });
		assert.deepEqual(spanBetween({ x: 0.75, y: 0.5 }, { x: 0.25, y: 0.1 }), { x: 0.25, y: 0.1, w: 0.5, h: 0.4 });
		assert.deepEqual(pointInPage({ left: 0, top: 0, width: 0, height: 0 }, { x: 5, y: 5 }), { x: 0, y: 0 });
	});

	it("round-trips a region through its on-screen box and enforces the minimum size", () => {
		const region = { x: 0.25, y: 0.5, w: 0.5, h: 0.25 };
		assert.deepEqual(boxOfRegion(page, region), { left: 200, top: 350, width: 200, height: 150 });
		assert.equal(isUsableRegion(page, { x: 0, y: 0, w: (MIN_REGION_PX - 1) / page.width, h: 1 }), false);
		assert.equal(isUsableRegion(page, { x: 0, y: 0, w: MIN_REGION_PX / page.width, h: MIN_REGION_PX / page.height }), true);
	});

	it("clips a box to its bounds and collapses it when they do not overlap", () => {
		const bounds = { left: 0, top: 0, width: 300, height: 300 };
		assert.deepEqual(clampBox({ left: -50, top: 250, width: 100, height: 100 }, bounds), { left: 0, top: 250, width: 50, height: 50 });
		const gone = clampBox({ left: 400, top: 400, width: 10, height: 10 }, bounds);
		assert.equal(gone.width, 0);
		assert.equal(gone.height, 0);
	});
});

const SAMPLE = path.join(import.meta.dirname, "fixtures/sample-3page.pdf");

function pngSize(png: Buffer): { width: number; height: number } {
	assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("renderPdfRegion", () => {
	it("paints only the crop at the crop's aspect ratio, within the long-side cap", async () => {
		const full = await renderPdfRegion(SAMPLE, 1, FULL, { maxSide: 800 });
		const half = await renderPdfRegion(SAMPLE, 1, { x: 0, y: 0, w: 0.5, h: 1 }, { maxSide: 800 });
		assert.ok(Math.max(full.width, full.height) <= 800);
		assert.deepEqual(pngSize(full.png), { width: full.width, height: full.height });
		assert.ok(Math.abs(half.width / half.height - (full.width * 0.5) / full.height) < 0.02);
		assert.ok(Math.max(half.width, half.height) <= 800);
	});

	it("rejects a page outside the document", async () => {
		await assert.rejects(renderPdfRegion(SAMPLE, 99, FULL), RangeError);
		await assert.rejects(renderPdfRegion(SAMPLE, 0, FULL), RangeError);
	});
});

function scripted(steps: FauxResponseStep[], vision = true) {
	const faux = createFauxCore({ tokenSize: { min: 8, max: 8 } });
	faux.setResponses(steps);
	const base = faux.getModel();
	const requests: { system: string; parts: { type: string }[] }[] = [];
	const engine: PiEngine = {
		model: { ...base, input: vision ? ["text", "image"] : ["text"] },
		streamFn: (model, context, options) => {
			const user = context.messages.find((m) => m.role === "user");
			requests.push({
				system: context.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : "")).join(""))).join("\n"),
				parts: user && Array.isArray(user.content) ? (user.content as { type: string }[]) : [],
			});
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, requests };
}

async function sessionWith(file: string): Promise<{ chatId: string; docId: string }> {
	const chat = chatStore.createChat("region transcription");
	const opened = await openDocumentPath(chat.id, file);
	assert.ok(opened);
	return { chatId: chat.id, docId: opened.documentId };
}

const scan = path.join(TMP, "scan.pdf");
fs.copyFileSync(SAMPLE, scan);
const REGION_BODY = { page: 2, region: { x: 0.1, y: 0.1, w: 0.6, h: 0.3 } };

async function failure(promise: Promise<unknown>): Promise<InstanceType<typeof RegionError>> {
	try {
		await promise;
	} catch (err) {
		assert.ok(err instanceof RegionError, `a RegionError, got ${String(err)}`);
		return err;
	}
	throw new assert.AssertionError({ message: "expected the transcription to be refused" });
}

describe("transcribeRegion", () => {
	it("reads the crop with the scan-reader model, stores the crop, and logs the billed call", async () => {
		const { chatId, docId } = await sessionWith(scan);
		const { engine, requests } = scripted([fauxAssistantMessage([fauxText("  Energy is $E=mc^2$.\n")])]);
		const result = await transcribeRegion(chatId, docId, REGION_BODY, { engine });
		assert.equal(result.transcript, "Energy is $E=mc^2$.");
		assert.match(result.snapshotId, /^[a-f0-9]{64}$/);
		assert.ok(result.width > 0 && result.height > 0);

		assert.equal(requests.length, 1, "one model call");
		assert.match(requests[0]!.system, /transcription engine for scanned study material/);
		assert.equal(requests[0]!.parts.filter((p) => p.type === "image").length, 1, "the crop reaches the model as an image");

		const record = chatStore.getChat(chatId)!;
		assert.ok(record.imageSnapshots?.[result.snapshotId], "the crop is stored for the transcript card");
		assert.equal(record.scans?.length, 1);
		assert.equal(record.scans?.[0]?.model, `${engine.model.provider}:${engine.model.id}`);
		assert.equal(record.scans?.[0]?.documentId, docId);
		assert.equal(record.scans?.[0]?.page, 2);
		assert.equal(record.scans?.[0]?.steps.length, 1);
	});

	it("an unreadable region is refused after the (billed) call, with nothing stored", async () => {
		const { chatId, docId } = await sessionWith(scan);
		const { engine } = scripted([fauxAssistantMessage([fauxText("[no readable content]")])]);
		const err = await failure(transcribeRegion(chatId, docId, REGION_BODY, { engine }));
		assert.equal(err.status, 422);
		assert.equal(err.body.code, REGION_EMPTY_CODE);
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.scans?.length, 1, "the spend is logged");
		assert.equal(record.imageSnapshots, undefined, "no crop kept for a refused read");
	});

	it("a model that cannot take images is refused before any call or render", async () => {
		const { chatId, docId } = await sessionWith(scan);
		const { engine, requests } = scripted([], false);
		const err = await failure(transcribeRegion(chatId, docId, REGION_BODY, { engine, render: async () => { throw new Error("must not render"); } }));
		assert.equal(err.status, 422);
		assert.equal(err.body.code, REGION_NO_IMAGE_INPUT_CODE);
		assert.equal(requests.length, 0);
		assert.equal(chatStore.getChat(chatId)!.scans, undefined);
	});

	it("refuses honestly when no scan-reader model is configured", async () => {
		const { chatId, docId } = await sessionWith(scan);
		const err = await failure(transcribeRegion(chatId, docId, REGION_BODY));
		assert.equal(err.status, 503);
		assert.equal(err.body.code, MODELS_NOT_CONFIGURED_CODE);
		assert.ok("missing" in err.body);
		assert.deepEqual(err.body.missing, ["vision"]);
	});

	it("rejects bad bodies, pages outside the document, and non-PDF documents", async () => {
		const { chatId, docId } = await sessionWith(scan);
		const { engine } = scripted([]);
		for (const body of [null, {}, { page: 0, region: FULL }, { page: 1.5, region: FULL }, { page: 1, region: { x: 0, y: 0, w: 2, h: 1 } }, { page: "1", region: FULL }]) {
			assert.equal((await failure(transcribeRegion(chatId, docId, body, { engine }))).status, 400, JSON.stringify(body));
		}
		assert.equal((await failure(transcribeRegion(chatId, docId, { page: 99, region: FULL }, { engine }))).status, 400);
		const md = path.join(TMP, "notes.md");
		fs.writeFileSync(md, "# Notes\n");
		const mdSession = await sessionWith(md);
		assert.equal((await failure(transcribeRegion(mdSession.chatId, mdSession.docId, { page: 1, region: FULL }, { engine }))).status, 400);
	});

	it("cancels without logging when the request is aborted before the render", async () => {
		const { chatId, docId } = await sessionWith(scan);
		const { engine, requests } = scripted([fauxAssistantMessage([fauxText("late")])]);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(transcribeRegion(chatId, docId, REGION_BODY, { engine, signal: controller.signal }), { name: "AbortError" });
		assert.equal(requests.length, 0);
		assert.equal(chatStore.getChat(chatId)!.scans, undefined);
	});
});

describe("POST …/documents/[docId]/region", () => {
	const post = (chatId: string, docId: string, body: BodyInit | null) =>
		route.POST(new Request("http://test/region", { method: "POST", headers: { "Content-Type": "application/json" }, body }), {
			params: Promise.resolve({ id: chatId, docId }),
		});

	it("answers 400 for a malformed body, 404 for an unknown document, 503 with the setup envelope when unconfigured", async () => {
		const { chatId, docId } = await sessionWith(scan);
		assert.equal((await post(chatId, docId, "not json")).status, 400);
		assert.equal((await post(chatId, "doc_000000000000", JSON.stringify(REGION_BODY))).status, 404);
		const refused = await post(chatId, docId, JSON.stringify(REGION_BODY));
		assert.equal(refused.status, 503);
		const body = (await refused.json()) as { code?: string; missing?: string[] };
		assert.equal(body.code, MODELS_NOT_CONFIGURED_CODE);
		assert.deepEqual(body.missing, ["vision"]);
	});
});
