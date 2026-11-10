/**
 * The agent reading scanned PDFs: the cached page reader (text layer / cache /
 * one budgeted vision read), the locator loop that finds a named section, the
 * server path with its billing log, the read_scanned_section tool's results,
 * and the page cache. A scripted faux engine answers both the locator and the
 * page reads; the page painter is replaced by a tiny PNG whose width names its
 * page. No tokens, isolated LH_DATA_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FauxResponseStep, JsonObject } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { PageRegion, SessionDocument } from "../src/core/documents.ts";
import type { ScanSectionReader, ScanSectionRequest } from "../src/core/scan-section.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-scan-section-"));
process.env.LH_DATA_DIR = TMP;

const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
const { createCanvas } = await import("@napi-rs/canvas");
const { PDFDocument } = await import("pdf-lib");
const { chatStore } = await import("../src/store/chats.ts");
const { openScanCache, scanCacheId } = await import("../src/store/scan-cache.ts");
const { viewerOf } = await import("../src/core/documents.ts");
const { SCAN_SECTION_MAX_TEXT_PAGES } = await import("../src/core/scan-section.ts");
const { ScanPageReader } = await import("../src/agent/documents/scan-pages.ts");
const { documentTools } = await import("../src/agent/tools/documents.ts");
const { openDocumentPath } = await import("../src/server/documents.ts");
const { readScannedSection } = await import("../src/server/scan-section.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

const TEXT_PDF = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const SCAN_PAGES = 20;
const SCAN_MASTER = path.join(TMP, "scan-master.pdf");

before(async () => {
	// A scanned book: every page is ONE raster image, no text layer.
	const pdf = await PDFDocument.create();
	for (let n = 1; n <= SCAN_PAGES; n++) {
		const canvas = createCanvas(60, 80);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#eee";
		ctx.fillRect(0, 0, 60, 80);
		const image = await pdf.embedPng(canvas.toBuffer("image/png"));
		pdf.addPage([300, 400]).drawImage(image, { x: 0, y: 0, width: 300, height: 400 });
	}
	fs.writeFileSync(SCAN_MASTER, await pdf.save());
});

/** A fresh copy of the scan (its own cache identity) registered in a fresh chat. */
async function scanSession(name: string): Promise<{ chatId: string; doc: SessionDocument; file: string }> {
	const file = path.join(TMP, `${name}.pdf`);
	fs.copyFileSync(SCAN_MASTER, file);
	const chat = chatStore.createChat(name);
	const opened = await openDocumentPath(chat.id, file);
	assert.ok(opened);
	const doc = viewerOf(chatStore.getChat(chat.id)!).documents[0]!;
	return { chatId: chat.id, doc, file };
}

/** The page painter stand-in: a PNG whose width is 10 + page, so the engine can tell which page it is shown. */
async function paintPage(_file: string, page: number, _region: PageRegion): Promise<{ png: Buffer; width: number; height: number }> {
	const canvas = createCanvas(10 + page, 12);
	canvas.getContext("2d").fillRect(0, 0, 10 + page, 12);
	return { png: canvas.toBuffer("image/png"), width: 10 + page, height: 12 };
}

const transcriptOf = (page: number): string => `Words of page ${page}.`;

interface ScriptedScan {
	engine: PiEngine;
	/** Pages shown to the vision model, in call order. */
	visionPages: number[];
	locatorCalls: () => number;
}

/** Vision calls (a request with an image) answer from `transcripts`; locator calls follow `locator` in order. */
function scriptedScan(locator: FauxResponseStep[], transcripts: (page: number) => string = transcriptOf, vision = true): ScriptedScan {
	const locatorCore = createFauxCore({ tokenSize: { min: 8, max: 8 } });
	locatorCore.setResponses(locator);
	const visionCore = createFauxCore({ tokenSize: { min: 8, max: 8 } });
	const base = locatorCore.getModel();
	const visionPages: number[] = [];
	let locatorCalls = 0;
	const engine: PiEngine = {
		model: { ...base, input: vision ? ["text", "image"] : ["text"] },
		streamFn: (model, context, options) => {
			const image = context.messages
				.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content : []))
				.find((part): part is { type: "image"; data: string; mimeType: string } => part.type === "image");
			if (!image) {
				locatorCalls++;
				return locatorCore.streamSimple(model, context, options);
			}
			const page = Buffer.from(image.data, "base64").readUInt32BE(16) - 10;
			visionPages.push(page);
			visionCore.setResponses([fauxAssistantMessage([fauxText(transcripts(page))])]);
			return visionCore.streamSimple(model, context, options);
		},
	};
	return { engine, visionPages, locatorCalls: () => locatorCalls };
}

const step = (name: string, args: JsonObject, id: string): FauxResponseStep =>
	fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

const TEXT_REQUEST: ScanSectionRequest = { topic: "Chapter Two", form: "text" };

describe("ScanPageReader", () => {
	it("prefers a text layer, then the cache, and spends at most the fresh-read budget", async () => {
		const { doc, file } = await scanSession("reader-budget");
		const { engine, visionPages } = scriptedScan([]);
		const cache = openScanCache(scanCacheId(doc, file));
		const reader = new ScanPageReader({ doc, file, pageCount: SCAN_PAGES, engine, cache, maxFresh: 3, render: paintPage });

		const first = await reader.read([4, 5, 6, 7, 8]);
		assert.deepEqual(first.pages.map((p) => [p.number, p.source]), [[4, "vision"], [5, "vision"], [6, "vision"]]);
		assert.deepEqual(first.unread, [7, 8], "pages past the budget are reported, never silently read");
		assert.equal(reader.freshLeft, 0);

		const again = await reader.read([5, 7]);
		assert.deepEqual(again.pages.map((p) => [p.number, p.source, p.text]), [[5, "cache", transcriptOf(5)]]);
		assert.deepEqual(again.unread, [7]);
		assert.deepEqual([...visionPages].sort((a, b) => a - b), [4, 5, 6], "the cached page cost nothing");
	});

	it("uses a page's own text layer without any vision read", async () => {
		const chat = chatStore.createChat("reader-textlayer");
		const opened = await openDocumentPath(chat.id, TEXT_PDF);
		assert.ok(opened);
		const doc = viewerOf(chatStore.getChat(chat.id)!).documents[0]!;
		const { engine, visionPages } = scriptedScan([]);
		const cache = openScanCache(scanCacheId(doc, TEXT_PDF));
		const reader = new ScanPageReader({ doc, file: TEXT_PDF, pageCount: 3, engine, cache, maxFresh: 5, render: paintPage });
		const { pages } = await reader.read([1, 2]);
		assert.deepEqual(pages.map((p) => p.source), ["text-layer", "text-layer"]);
		assert.ok(pages[0]!.text.trim().length > 0);
		assert.equal(visionPages.length, 0);
	});

	it("stores a blank page as blank so it is not bought twice, and rejects pages outside the document", async () => {
		const { doc, file } = await scanSession("reader-blank");
		const { engine, visionPages } = scriptedScan([], (page) => (page === 3 ? "[no readable content]" : transcriptOf(page)));
		const cache = openScanCache(scanCacheId(doc, file));
		const reader = new ScanPageReader({ doc, file, pageCount: SCAN_PAGES, engine, cache, maxFresh: 10, render: paintPage });
		assert.deepEqual((await reader.read([3])).pages.map((p) => [p.number, p.text, p.source]), [[3, "", "vision"]]);
		assert.deepEqual((await reader.read([3])).pages.map((p) => [p.text, p.source]), [["", "cache"]]);
		assert.deepEqual(visionPages, [3]);
		await assert.rejects(reader.read([0]), RangeError);
		await assert.rejects(reader.read([SCAN_PAGES + 1]), RangeError);
	});
});

describe("readScannedSection", () => {
	it("finds the section, returns its verbatim pages, bills each page once, and never re-reads a cached page", async () => {
		const { chatId, doc } = await scanSession("section-text");
		const script = () => [
			step("read_pages", { pages: "1-2" }, "r1"),
			step("read_pages", { pages: "5" }, "r2"),
			step("deliver_section", { title: "Chapter Two", firstPage: 5, lastPage: 7 }, "d1"),
		];
		const first = scriptedScan(script());
		const result = await readScannedSection(chatId, doc, TEXT_REQUEST, { engine: first.engine, render: paintPage });
		assert.deepEqual(result, {
			kind: "text",
			title: "Chapter Two",
			firstPage: 5,
			lastPage: 7,
			continues: false,
			pages: [5, 6, 7].map((number) => ({ number, text: transcriptOf(number) })),
		});
		assert.deepEqual([...first.visionPages].sort((a, b) => a - b), [1, 2, 5, 6, 7], "only the pages it needed, never the whole book");
		assert.equal(first.locatorCalls(), 3);

		const afterFirst = chatStore.getChat(chatId)!.scans!;
		assert.deepEqual(afterFirst.filter((s) => s.page !== undefined).map((s) => s.page).sort((a, b) => a! - b!), [1, 2, 5, 6, 7]);
		const locatorEntry = afterFirst.find((s) => s.page === undefined)!;
		assert.equal(locatorEntry.steps.length, 3, "the locator's own three model calls");
		assert.equal(locatorEntry.documentId, doc.id);

		const second = scriptedScan(script());
		assert.deepEqual(await readScannedSection(chatId, doc, TEXT_REQUEST, { engine: second.engine, render: paintPage }), result);
		assert.equal(second.visionPages.length, 0, "every page came from the cache");
		assert.equal(chatStore.getChat(chatId)!.scans!.length, afterFirst.length + 1, "only the locator run was billed again");
	});

	it("cuts a long section at the page cap and says it continues", async () => {
		const { chatId, doc } = await scanSession("section-cap");
		const { engine } = scriptedScan([step("deliver_section", { title: "Everything", firstPage: 1, lastPage: SCAN_PAGES }, "d1")]);
		const result = await readScannedSection(chatId, doc, TEXT_REQUEST, { engine, render: paintPage });
		assert.equal(result.kind, "text");
		if (result.kind !== "text") return;
		assert.equal(result.pages.length, SCAN_SECTION_MAX_TEXT_PAGES);
		assert.equal(result.lastPage, SCAN_SECTION_MAX_TEXT_PAGES);
		assert.equal(result.continues, true);
	});

	it("delivers a summary with its pages sorted and kept inside the document", async () => {
		const { chatId, doc } = await scanSession("section-summary");
		const { engine } = scriptedScan([
			step("read_pages", { pages: "6" }, "r1"),
			step("deliver_summary", { summary: "It argues from doubt (p. 6).", pages: [7, 6, 6, 99] }, "d1"),
		]);
		const result = await readScannedSection(chatId, doc, { topic: "the argument", form: "summary", focus: "the doubt" }, { engine, render: paintPage });
		assert.deepEqual(result, { kind: "summary", summary: "It argues from doubt (p. 6).", pages: [6, 7] });
	});

	it("tells a model that picked the wrong delivery tool and lets it continue", async () => {
		const { chatId, doc } = await scanSession("section-wrong-tool");
		const { engine } = scriptedScan([
			step("deliver_summary", { summary: "x", pages: [1] }, "d1"),
			step("deliver_section", { title: "Chapter Two", firstPage: 2, lastPage: 2 }, "d2"),
		]);
		const result = await readScannedSection(chatId, doc, TEXT_REQUEST, { engine, render: paintPage });
		assert.equal(result.kind, "text");
	});

	it("reports an unfindable section, and a locator that runs out of steps", async () => {
		const { chatId, doc } = await scanSession("section-missing");
		const missing = scriptedScan([step("read_pages", { pages: "1" }, "r1"), step("deliver_not_found", { note: "The contents list no such chapter." }, "n1")]);
		assert.deepEqual(await readScannedSection(chatId, doc, TEXT_REQUEST, { engine: missing.engine, render: paintPage }), {
			kind: "not-found",
			note: "The contents list no such chapter.",
		});

		const endless = scriptedScan(Array.from({ length: 12 }, (_, i) => step("read_pages", { pages: String(i + 1) }, `r${i}`)));
		const stopped = await readScannedSection(chatId, doc, TEXT_REQUEST, { engine: endless.engine, render: paintPage });
		assert.equal(stopped.kind, "not-found");
		assert.equal(endless.locatorCalls(), 12, "the step budget ends the loop");
		assert.equal(endless.visionPages.length, 12 - 1, "pages the locator already read cost nothing again (page 1 was read by the first run)");
	});

	it("reports what a locator said when it stops in plain words, instead of blaming the step limit", async () => {
		const { chatId, doc } = await scanSession("section-plain-words");
		const notice = "This version of Antigravity is no longer supported. Please download and install the latest version.";
		const { engine, locatorCalls, visionPages } = scriptedScan([fauxAssistantMessage([fauxText(notice)])]);
		const result = await readScannedSection(chatId, doc, TEXT_REQUEST, { engine, render: paintPage });
		assert.deepEqual(result, { kind: "not-found", note: `The reader stopped without delivering and said: "${notice}"` });
		assert.equal(locatorCalls(), 1, "it was one turn, not a run of twelve");
		assert.equal(visionPages.length, 0);
	});

	it("refuses before any model call when nothing can read images or the file is not a PDF", async () => {
		const { chatId, doc } = await scanSession("section-refusals");
		const textOnly = scriptedScan([], transcriptOf, false);
		await assert.rejects(readScannedSection(chatId, doc, TEXT_REQUEST, { engine: textOnly.engine, render: paintPage }), /does not accept images/);
		await assert.rejects(readScannedSection(chatId, doc, TEXT_REQUEST, { render: paintPage }), /No scan-reading model is configured/);
		await assert.rejects(readScannedSection(chatId, { ...doc, format: "markdown" }, TEXT_REQUEST, { engine: textOnly.engine }), /PDF documents only/);
		assert.equal(textOnly.locatorCalls() + textOnly.visionPages.length, 0);
		assert.equal(chatStore.getChat(chatId)!.scans, undefined);
	});

	it("bills what was spent even when the call is cancelled mid-way", async () => {
		const { chatId, doc } = await scanSession("section-cancel");
		const controller = new AbortController();
		const { engine } = scriptedScan([step("read_pages", { pages: "1-2" }, "r1"), step("read_pages", { pages: "3" }, "r2")]);
		const cancelling: PiEngine = {
			...engine,
			streamFn: (model, context, options) => {
				// Abort as the second locator call starts: pages 1-2 were read and billed already.
				if (context.messages.some((m) => m.role === "toolResult")) controller.abort();
				return engine.streamFn(model, context, options);
			},
		};
		await assert.rejects(readScannedSection(chatId, doc, TEXT_REQUEST, { engine: cancelling, render: paintPage, signal: controller.signal }), { name: "AbortError" });
		const pages = chatStore.getChat(chatId)!.scans!.filter((s) => s.page !== undefined).map((s) => s.page).sort((a, b) => a! - b!);
		assert.deepEqual(pages, [1, 2]);
	});
});

describe("the scan page cache", () => {
	it("keys uploads by content hash and path documents by path + size + mtime, and reads a damaged file as empty", async () => {
		const { doc, file } = await scanSession("cache-id");
		const id = scanCacheId(doc, file);
		assert.match(id, /^[a-f0-9]{64}$/);
		assert.equal(scanCacheId(doc, file), id);
		const sha = "b".repeat(64);
		assert.equal(scanCacheId({ ...doc, source: { kind: "upload", sha256: sha, ext: ".pdf" } }, file), sha);
		const later = new Date(Date.now() + 5000);
		fs.utimesSync(file, later, later);
		assert.notEqual(scanCacheId(doc, file), id, "an edited file starts with an empty cache");

		const cache = openScanCache(id);
		assert.equal(cache.get(2), undefined);
		cache.put(2, { text: "two", model: "m:1", at: "t" });
		assert.deepEqual(cache.get(2), { text: "two", model: "m:1", at: "t" });
		fs.writeFileSync(path.join(TMP, "scan-cache", `${id}.json`), "{ not json");
		assert.equal(openScanCache(id).get(2), undefined);
		cache.put(3, { text: "three", model: "m:1", at: "t" });
		assert.equal(openScanCache(id).get(3)?.text, "three", "the next write replaces the damaged file");
	});
});

describe("read_scanned_section tool", () => {
	const sessionFor = async (reader?: ScanSectionReader) => {
		const { chatId, doc } = await scanSession(`tool-${Math.random().toString(36).slice(2, 8)}`);
		const tools = documentTools({ chatId, chatStore, ...(reader ? { readScannedSection: reader } : {}) });
		const run = async (input: unknown): Promise<string> => {
			const result = (await tools.read_scanned_section!.execute("call", input as never, undefined as never, undefined as never)) as { content: { text?: string }[] };
			return result.content.map((c) => c.text ?? "").join("");
		};
		return { doc, run };
	};

	it("hands the agent the section's pages under page markers, flagged as machine-read", async () => {
		const requests: ScanSectionRequest[] = [];
		const { doc, run } = await sessionFor(async (_doc, request) => {
			requests.push(request);
			return { kind: "text", title: "Meditation II", firstPage: 5, lastPage: 6, continues: true, pages: [{ number: 5, text: "I am, I exist." }, { number: 6, text: "" }] };
		});
		const out = await run({ document: doc.id, topic: "  the cogito  ", form: "text", focus: "  ignored for text  " });
		assert.deepEqual(requests, [{ topic: "  the cogito  ", form: "text", focus: "ignored for text" }]);
		assert.match(
			out,
			/^Section "Meditation II" · tool-[a-z0-9]+\.pdf · pages 5–6\nRead from the scan by a vision model — it may contain transcription errors\.\nThe section continues past page 6; it was cut at 15 pages\.\n\n--- Page 5 ---\n\nI am, I exist\.\n\n--- Page 6 ---\n\n\(blank or unreadable page\)$/,
		);
	});

	it("returns summaries and a not-found as ordinary results the agent can act on", async () => {
		const { doc, run } = await sessionFor(async (_doc, request) =>
			request.form === "summary"
				? { kind: "summary", summary: "Doubt first (p. 6).", pages: [6, 8] }
				: { kind: "not-found", note: "No such chapter." },
		);
		assert.match(await run({ document: doc.id, topic: "doubt", form: "summary", focus: "method" }), /^Summary of "doubt" · .*· pages 6–8\nRead from the scan.*\n\nDoubt first \(p\. 6\)\.$/s);
		assert.match(await run({ document: doc.id, topic: "Meditation IX", form: "text" }), /^Section "Meditation IX" was not found in .*: No such chapter\.$/);
	});

	it("says so when the session has no section reader, and refuses non-PDF documents", async () => {
		const { doc, run } = await sessionFor();
		await assert.rejects(run({ document: doc.id, topic: "x", form: "text" }), /not available in this session/);
		const md = path.join(TMP, "notes.md");
		fs.writeFileSync(md, "# Notes\n");
		const { run: runWithReader } = await sessionFor(async () => ({ kind: "not-found", note: "unused" }));
		await assert.rejects(runWithReader({ document: md, topic: "x", form: "text" }), /PDF documents only/);
	});

	it("read_document tells the agent which shown pages are scans", async () => {
		await scanSession("read-document-note");
		const tools = documentTools({ chatId: chatStore.createChat("read-note").id, chatStore });
		const read = async (input: unknown): Promise<string> => {
			const result = (await tools.read_document!.execute("c", input as never, undefined as never, undefined as never)) as { content: { text?: string }[] };
			return result.content.map((c) => c.text ?? "").join("");
		};
		const file = path.join(TMP, "read-document-note.pdf");
		const scanned = await read({ document: file, pages: "1-3" });
		assert.match(scanned, /\[3 of 3 pages shown have no text layer \(scanned\)\. read_scanned_section reads a section of them/);
		const digital = await read({ document: TEXT_PDF });
		assert.ok(!digital.includes("no text layer (scanned)"), "a text PDF gets no scan note");
		assert.ok(scanned.includes("--- Page 1 ---"), "the page markers still show");
	});
});
