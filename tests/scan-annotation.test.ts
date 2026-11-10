/**
 * Annotating scanned PDF pages: the rotation-aware mapping from a page region to
 * PDF coordinates (checked against pdf.js's own idea of the displayed page), the
 * Highlight actually written, the boxer's answer parsing and refusals, the
 * server path with its billing log, and propose_annotation's scanned path through
 * to the learner accepting it. A scripted faux engine answers the vision call;
 * the page painter is a tiny PNG. No tokens, isolated LH_DATA_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { PiEngine } from "../src/agent/models.ts";
import type { PageRegion, SessionDocument } from "../src/core/documents.ts";
import type { ScanPassageLocator } from "../src/core/scan-section.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-scan-annotation-"));
process.env.LH_DATA_DIR = TMP;

const { createFauxCore, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
const { createCanvas } = await import("@napi-rs/canvas");
const { PDFDocument, degrees } = await import("pdf-lib");
const { chatStore } = await import("../src/store/chats.ts");
const { viewerOf } = await import("../src/core/documents.ts");
const { annotatePdf, regionQuad } = await import("../src/agent/documents/annotate-pdf.ts");
const { parseBoxerAnswer, SCAN_BOXER_MAX_LINES, ScanBoxerError } = await import("../src/agent/subagents/scan-boxer.ts");
const { documentTools } = await import("../src/agent/tools/documents.ts");
const { decideAnnotations, openDocumentPath } = await import("../src/server/documents.ts");
const { locateScanPassage } = await import("../src/server/scan-boxes.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

const TEXT_PDF = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const MIXED = path.join(TMP, "mixed.pdf");

before(async () => {
	// Three text pages (the fixture) and a fourth that is one raster image: no text layer.
	const pdf = await PDFDocument.load(fs.readFileSync(TEXT_PDF));
	const canvas = createCanvas(60, 80);
	canvas.getContext("2d").fillRect(0, 0, 60, 80);
	const image = await pdf.embedPng(canvas.toBuffer("image/png"));
	pdf.addPage([300, 400]).drawImage(image, { x: 0, y: 0, width: 300, height: 400 });
	fs.writeFileSync(MIXED, await pdf.save());
});

const round = (numbers: number[]) => numbers.map((n) => Math.round(n * 1e6) / 1e6);

describe("regionQuad", () => {
	const box = { x: 10, y: 20, width: 200, height: 100 };
	const region: PageRegion = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

	it("maps the displayed page onto the crop box for each page rotation", () => {
		assert.deepEqual(round(regionQuad(box, 0, region)), [30, 100, 90, 100, 30, 60, 90, 60]);
		assert.deepEqual(round(regionQuad(box, 90, region)), [50, 60, 130, 60, 50, 30, 130, 30]);
		assert.deepEqual(round(regionQuad(box, 180, region)), [130, 80, 190, 80, 130, 40, 190, 40]);
		assert.deepEqual(round(regionQuad(box, 270, region)), [90, 110, 170, 110, 90, 80, 170, 80]);
	});

	it("reads negative and over-full turns as their equivalent rotation", () => {
		assert.deepEqual(regionQuad(box, -90, region), regionQuad(box, 270, region));
		assert.deepEqual(regionQuad(box, 450, region), regionQuad(box, 90, region));
	});

	it("lands exactly where pdf.js displays the region, on a cropped page, at every rotation", async () => {
		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		for (const rotation of [0, 90, 180, 270]) {
			const pdf = await PDFDocument.create();
			const page = pdf.addPage([300, 400]);
			page.setCropBox(20, 30, 200, 100);
			page.setRotation(degrees(rotation));
			const { bytes } = await annotatePdf(await pdf.save(), [{ id: "ann_00000001", quote: "q", page: 1, regions: [region], note: "n" }], new Date());
			assert.ok(bytes, `rotation ${rotation}: written`);

			const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
			try {
				const shown = await (await task.promise).getPage(1);
				const viewport = shown.getViewport({ scale: 1 });
				const [annotation] = await shown.getAnnotations();
				assert.ok(annotation, `rotation ${rotation}: pdf.js reads the highlight`);
				const [xa, ya] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
				const [xb, yb] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
				const got = [Math.min(xa, xb) / viewport.width, Math.min(ya, yb) / viewport.height, Math.abs(xb - xa) / viewport.width, Math.abs(yb - ya) / viewport.height];
				got.forEach((value, i) => assert.ok(Math.abs(value - [region.x, region.y, region.w, region.h][i]!) < 1e-6, `rotation ${rotation}: ${["x", "y", "w", "h"][i]} ${value}`));
			} finally {
				await task.destroy();
			}
		}
	});
});

describe("annotatePdf with regions", () => {
	it("writes one Highlight carrying every line's quad, without consulting any text", async () => {
		const { bytes, outcomes } = await annotatePdf(
			new Uint8Array(fs.readFileSync(MIXED)),
			[{ id: "ann_aaaaaaaa", quote: "words that exist nowhere in the text layer", page: 4, regions: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }, { x: 0.1, y: 0.26, w: 0.3, h: 0.05 }], note: "the cogito" }],
			new Date(),
		);
		assert.deepEqual(outcomes, [{ id: "ann_aaaaaaaa", result: "written" }]);
		const pdf = await PDFDocument.load(bytes!);
		assert.equal(pdf.getPage(3).node.Annots()?.size(), 1);
		assert.equal(pdf.getPage(0).node.Annots()?.size() ?? 0, 0, "no other page was touched");
	});

	it("fails an annotation whose page is not in the file instead of writing anywhere", async () => {
		const { bytes, outcomes } = await annotatePdf(
			new Uint8Array(fs.readFileSync(MIXED)),
			[{ id: "ann_bbbbbbbb", quote: "q", page: 9, regions: [{ x: 0, y: 0, w: 0.1, h: 0.1 }], note: "n" }, { id: "ann_cccccccc", quote: "q", regions: [{ x: 0, y: 0, w: 0.1, h: 0.1 }], note: "n" }],
			new Date(),
		);
		assert.equal(bytes, null);
		assert.deepEqual(outcomes.map((o) => [o.id, o.result, "failure" in o ? o.failure : undefined]), [["ann_bbbbbbbb", "failed", "not-found"], ["ann_cccccccc", "failed", "not-found"]]);
	});
});

describe("parseBoxerAnswer", () => {
	it("turns the 0–1000 line boxes into page regions, also from a fenced answer", () => {
		const expected = [{ x: 0.2, y: 0.1, w: 0.6, h: 0.05 }, { x: 0.2, y: 0.16, w: 0.3, h: 0.05 }];
		const answer = '{"found": true, "lines": [[100, 200, 150, 800], [160, 200, 210, 500]]}';
		assert.deepEqual(parseBoxerAnswer(answer).map((r) => ({ x: r.x, y: Math.round(r.y * 1e6) / 1e6, w: r.w, h: Math.round(r.h * 1e6) / 1e6 })), expected);
		assert.equal(parseBoxerAnswer(`Here it is:\n\`\`\`json\n${answer}\n\`\`\``).length, 2);
	});

	it("clamps a box that overshoots the page edge by a hair", () => {
		assert.deepEqual(parseBoxerAnswer('{"found": true, "lines": [[-5, 0, 100, 1004]]}'), [{ x: 0, y: 0, w: 1, h: 0.1 }]);
	});

	it("says not-found for found:false, and refuses answers that locate nothing usable", () => {
		assert.throws(() => parseBoxerAnswer('{"found": false}'), (e: unknown) => e instanceof ScanBoxerError && e.kind === "not-found");
		const tooMany = JSON.stringify({ found: true, lines: Array.from({ length: SCAN_BOXER_MAX_LINES + 1 }, (_, i) => [i * 20, 0, i * 20 + 10, 500]) });
		const unusable = [
			"no idea",
			'{"found": true}',
			'{"found": true, "lines": []}',
			'{"found": true, "lines": [["a", 0, 1, 1]]}',
			'{"found": true, "lines": [[300, 100, 200, 500]]}',
			'{"found": true, "lines": [[100, 100, 100, 500]]}',
			'{"found": true, "lines": [[0, 0, 1000, 1000]]}',
			tooMany,
		];
		for (const answer of unusable) {
			assert.throws(() => parseBoxerAnswer(answer), (e: unknown) => e instanceof ScanBoxerError && e.kind === "unreadable", answer.slice(0, 40));
		}
	});
});

async function scanChat(name: string): Promise<{ chatId: string; doc: SessionDocument }> {
	const chat = chatStore.createChat(name);
	assert.ok(await openDocumentPath(chat.id, MIXED));
	return { chatId: chat.id, doc: viewerOf(chatStore.getChat(chat.id)!).documents[0]! };
}

async function paintPage(): Promise<{ png: Buffer; width: number; height: number }> {
	const canvas = createCanvas(30, 40);
	canvas.getContext("2d").fillRect(0, 0, 30, 40);
	return { png: canvas.toBuffer("image/png"), width: 30, height: 40 };
}

/** An engine whose one answer is `answer`; counts the model calls it served. */
function boxerEngine(answer: string, vision = true): { engine: PiEngine; calls: () => number } {
	const core = createFauxCore({ tokenSize: { min: 8, max: 8 } });
	core.setResponses([fauxAssistantMessage([fauxText(answer)])]);
	let calls = 0;
	const engine: PiEngine = {
		model: { ...core.getModel(), input: vision ? ["text", "image"] : ["text"] },
		streamFn: (model, context, options) => {
			calls++;
			return core.streamSimple(model, context, options);
		},
	};
	return { engine, calls: () => calls };
}

describe("locateScanPassage", () => {
	it("returns the passage's line boxes and bills the one vision call against the page", async () => {
		const { chatId, doc } = await scanChat("locate-ok");
		const { engine, calls } = boxerEngine('{"found": true, "lines": [[100, 100, 150, 900]]}');
		const regions = await locateScanPassage(chatId, doc, 4, "the cogito", { engine, render: paintPage });
		assert.deepEqual(regions, [{ x: 0.1, y: 0.1, w: 0.8, h: 0.05 }]);
		assert.equal(calls(), 1);
		const scans = chatStore.getChat(chatId)!.scans!;
		assert.equal(scans.length, 1);
		assert.deepEqual([scans[0]!.documentId, scans[0]!.page, scans[0]!.steps.length], [doc.id, 4, 1]);
		assert.equal(scans[0]!.model, `${engine.model.provider}:${engine.model.id}`);
	});

	it("tells the agent when the passage is not on the page or the answer is unusable, and still bills the call", async () => {
		const { chatId, doc } = await scanChat("locate-refused");
		await assert.rejects(
			locateScanPassage(chatId, doc, 4, "q", { engine: boxerEngine('{"found": false}').engine, render: paintPage }),
			/could not find that passage on page 4\. Check the page number and the quote/,
		);
		await assert.rejects(
			locateScanPassage(chatId, doc, 4, "q", { engine: boxerEngine("sorry, no").engine, render: paintPage }),
			/could not place the passage on page 4: The model's answer was not JSON/,
		);
		assert.equal(chatStore.getChat(chatId)!.scans!.length, 2);
	});

	it("refuses before any model call when no image-capable scan reader exists, or the page is outside the file", async () => {
		const { chatId, doc } = await scanChat("locate-gated");
		const textOnly = boxerEngine("{}", false);
		await assert.rejects(locateScanPassage(chatId, doc, 4, "q", { engine: textOnly.engine, render: paintPage }), /does not accept images/);
		await assert.rejects(locateScanPassage(chatId, doc, 4, "q", { render: paintPage }), /No scan-reading model is configured/);
		await assert.rejects(locateScanPassage(chatId, { ...doc, format: "markdown" }, 4, "q", { engine: textOnly.engine }), /PDF documents only/);
		await assert.rejects(locateScanPassage(chatId, doc, 40, "q", { engine: boxerEngine("{}").engine }), /outside 1–4/);
		assert.equal(textOnly.calls(), 0);
		assert.equal(chatStore.getChat(chatId)!.scans, undefined);
	});
});

describe("propose_annotation on a scanned page", () => {
	const LINE: PageRegion = { x: 0.1, y: 0.2, w: 0.5, h: 0.05 };

	async function session(locate?: ScanPassageLocator) {
		const { chatId, doc } = await scanChat(`propose-${Math.random().toString(36).slice(2, 8)}`);
		const tools = documentTools({ chatId, chatStore, ...(locate ? { locateScanPassage: locate } : {}) });
		const run = async (input: unknown): Promise<string> => {
			const result = (await tools.propose_annotation!.execute("call_1", input as never, undefined as never, undefined as never)) as { content: { text?: string }[] };
			return result.content.map((c) => c.text ?? "").join("");
		};
		const annotations = () => viewerOf(chatStore.getChat(chatId)!).annotations;
		return { chatId, doc, run, annotations };
	}

	it("stores the located boxes as a pending annotation, and accepting writes them into the file", async () => {
		const asked: unknown[][] = [];
		const { chatId, doc, run, annotations } = await session(async (...args) => {
			asked.push(args.slice(0, 3));
			return [LINE];
		});
		const out = await run({ document: doc.id, quote: "همانا من هستم", page: 4, note: "کوگیتو" });
		assert.match(out, /^Proposed annotation ann_[0-9a-f]{8} on mixed\.pdf p\. 4\. A vision model placed the highlight on the scanned page \(1 line\)/);
		assert.deepEqual(asked, [[doc, 4, "همانا من هستم"]]);
		const [pending] = annotations();
		assert.deepEqual([pending!.status, pending!.page, pending!.regions], ["pending", 4, [LINE]]);

		const decided = await decideAnnotations(chatId, [pending!.id], "accept");
		assert.deepEqual(decided!.outcomes, [{ id: pending!.id, outcome: "accepted" }]);

		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(MIXED)), verbosity: 0 });
		try {
			const annotated = await (await task.promise).getPage(4);
			const [highlight] = await annotated.getAnnotations();
			assert.deepEqual(round(highlight.rect), [30, 300, 180, 320], "the 300×400 page's region, y flipped into PDF space");
			assert.equal(highlight.contentsObj.str, "کوگیتو");
		} finally {
			await task.destroy();
		}
	});

	it("never calls the locator for a page that has a text layer", async () => {
		let asked = 0;
		const { run, annotations } = await session(async () => {
			asked++;
			return [LINE];
		});
		await run({ document: TEXT_PDF, quote: "force equals mass times acceleration", page: 2, note: "Newton" });
		assert.equal(asked, 0);
		assert.equal(annotations()[0]!.regions, undefined);
	});

	it("keeps nothing when the locator cannot place the passage", async () => {
		const { doc, run, annotations } = await session(async () => {
			throw new Error("The scan reader could not find that passage on page 4.");
		});
		await assert.rejects(run({ document: doc.id, quote: "q", page: 4, note: "n" }), /could not find that passage on page 4/);
		assert.deepEqual(annotations(), []);
	});

	it("says so when the session has no locator, and asks for `page` when a quote is missing from a PDF that has scans", async () => {
		const { doc, run } = await session();
		await assert.rejects(run({ document: doc.id, quote: "q", page: 4, note: "n" }), /Annotating scanned pages is not available in this session/);
		await assert.rejects(run({ document: doc.id, quote: "words from a scanned page", note: "n" }), /pages without a text layer \(scans\); for a passage on one of those, give `page`/);
		await assert.rejects(run({ document: TEXT_PDF, quote: "words that are nowhere", note: "n" }), (e: unknown) => e instanceof Error && !e.message.includes("give `page`"));
	});
});
