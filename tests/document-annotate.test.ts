/**
 * Annotation writers — PDF Highlight, Word comment, Markdown <mark> + footnote.
 * Each writer is exercised on bytes built in-test, then re-read the way the
 * learner's own tools would read them (pdf.js, mammoth, the XML parts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { annotateDocx } from "../src/agent/documents/annotate-docx.ts";
import { annotateMarkdown } from "../src/agent/documents/annotate-markdown.ts";
import { annotatePdf } from "../src/agent/documents/annotate-pdf.ts";
import { openPdfBytes } from "../src/agent/subagents/pdf-ops.ts";

const NOW = new Date("2026-01-02T03:04:05.678Z");

async function pdfWith(...pages: string[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (const text of pages) doc.addPage([400, 300]).drawText(text, { x: 40, y: 200, size: 14, font });
	return doc.save();
}

describe("annotatePdf", () => {
	it("writes a Highlight annotation pdf.js reads back with the note and the LearnHarness author", async () => {
		const bytes = await pdfWith("Page one is about optics.", "The conservation of energy holds here.");
		const { bytes: out, outcomes } = await annotatePdf(bytes, [{ id: "ann_00000001", quote: "conservation of energy", page: 2, note: "Key law" }], NOW);
		assert.deepEqual(outcomes, [{ id: "ann_00000001", result: "written" }]);
		const { doc, task } = await openPdfBytes(out!.slice());
		try {
			const annotations = await (await doc.getPage(2)).getAnnotations();
			assert.equal(annotations.length, 1);
			const a = annotations[0] as { subtype: string; contentsObj: { str: string }; titleObj: { str: string }; rect: number[] };
			assert.equal(a.subtype, "Highlight");
			assert.equal(a.contentsObj.str, "Key law");
			assert.equal(a.titleObj.str, "LearnHarness");
			// the highlight sits on the words, not the page: the rect is inside the text line's extent
			assert.ok(a.rect[0]! > 40 && a.rect[2]! < 400, `rect ${a.rect.join(",")}`);
			assert.equal((await (await doc.getPage(1)).getAnnotations()).length, 0);
		} finally {
			await task.destroy();
		}
	});

	it("fails a quote that is on no page and writes nothing", async () => {
		const bytes = await pdfWith("Only optics here.");
		const result = await annotatePdf(bytes, [{ id: "ann_00000002", quote: "thermodynamics", note: "n" }], NOW);
		assert.equal(result.bytes, null);
		assert.deepEqual(result.outcomes.map((o) => o.result === "failed" && o.failure), ["not-found"]);
	});
});

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function docxWith(bodyXml: string): Promise<Uint8Array> {
	const zip = new JSZip();
	zip.file("[Content_Types].xml", CONTENT_TYPES);
	zip.file("_rels/.rels", ROOT_RELS);
	zip.file("word/_rels/document.xml.rels", DOC_RELS);
	zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${bodyXml}</w:body></w:document>`);
	return zip.generateAsync({ type: "uint8array" });
}

const run = (text: string, rPr = "") => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;

describe("annotateDocx", () => {
	it("adds a LearnHarness comment, a highlight placed by schema order, and keeps the text intact", async () => {
		const original = await docxWith(
			`<w:p>${run("The conservation of ")}${run("energy holds", "<w:rPr><w:b/><w:u w:val=\"single\"/></w:rPr>")}${run(" here.")}</w:p>`,
		);
		const before = (await mammoth.extractRawText({ buffer: Buffer.from(original) })).value;
		const { bytes, outcomes } = await annotateDocx(original, [{ id: "ann_00000003", quote: "conservation of energy", note: "Key law\nsecond line" }], NOW);
		assert.deepEqual(outcomes, [{ id: "ann_00000003", result: "written" }]);
		const zip = await JSZip.loadAsync(bytes!);
		const comments = await zip.file("word/comments.xml")!.async("string");
		assert.match(comments, /w:author="LearnHarness"/);
		assert.match(comments, /w:initials="LH"/);
		assert.match(comments, /w:date="2026-01-02T03:04:05Z"/);
		assert.equal((comments.match(/<w:p>/g) ?? []).length, 2, "one paragraph per note line");
		assert.match(await zip.file("word/_rels/document.xml.rels")!.async("string"), /relationships\/comments"[^>]*Target="comments.xml"|Target="comments.xml"[^>]*relationships\/comments"/);
		assert.match(await zip.file("[Content_Types].xml")!.async("string"), /PartName="\/word\/comments.xml"/);
		const document = await zip.file("word/document.xml")!.async("string");
		assert.match(document, /<w:commentRangeStart w:id="0"\/>/);
		assert.match(document, /<w:commentRangeEnd w:id="0"\/>/);
		assert.match(document, /<w:commentReference w:id="0"\/>/);
		assert.ok(document.indexOf("commentRangeStart") < document.indexOf("conservation"));
		assert.ok(document.indexOf("commentRangeEnd") > document.indexOf("energy"));
		// w:highlight precedes w:u in the run that already had underline
		assert.match(document, /<w:highlight w:val="yellow"\/><w:u w:val="single"\/>/);
		const after = (await mammoth.extractRawText({ buffer: Buffer.from(bytes!) })).value;
		assert.equal(after, before);
	});

	it("refuses a passage spanning two paragraphs and a passage inside a tracked change", async () => {
		const spanning = await docxWith(`<w:p>${run("First paragraph ends here")}</w:p><w:p>${run("Second paragraph starts here")}</w:p>`);
		const a = await annotateDocx(spanning, [{ id: "ann_00000004", quote: "ends here Second paragraph", note: "n" }], NOW);
		assert.equal(a.bytes, null);
		assert.deepEqual(a.outcomes.map((o) => o.result === "failed" && o.failure), ["unsupported"]);

		const tracked = await docxWith(`<w:p><w:ins w:id="9" w:author="x" w:date="2026-01-01T00:00:00Z">${run("inserted words only")}</w:ins></w:p>`);
		const b = await annotateDocx(tracked, [{ id: "ann_00000005", quote: "inserted words", note: "n" }], NOW);
		assert.deepEqual(b.outcomes.map((o) => o.result === "failed" && o.failure), ["unsupported"]);
	});

	it("numbers a second comment after the first", async () => {
		const original = await docxWith(`<w:p>${run("Alpha beta gamma delta.")}</w:p>`);
		const first = await annotateDocx(original, [{ id: "ann_00000006", quote: "Alpha beta", note: "one" }], NOW);
		const second = await annotateDocx(first.bytes!, [{ id: "ann_00000007", quote: "gamma delta", note: "two" }], NOW);
		const zip = await JSZip.loadAsync(second.bytes!);
		const comments = await zip.file("word/comments.xml")!.async("string");
		assert.match(comments, /w:id="0"/);
		assert.match(comments, /w:id="1"/);
		assert.equal((comments.match(/<w:comment /g) ?? []).length, 2);
	});
});

describe("annotateMarkdown", () => {
	it("wraps the passage in <mark> with a footnote reference and appends the footnote", () => {
		const { text, outcomes } = annotateMarkdown("# Title\n\nEnergy is **conserved** always.\n", [{ id: "ann_00000008", quote: "conserved always", note: "Key" }]);
		assert.deepEqual(outcomes, [{ id: "ann_00000008", result: "written" }]);
		assert.equal(text, "# Title\n\nEnergy is **<mark>conserved** always</mark>[^lh-1].\n\n[^lh-1]: Key (LearnHarness)\n");
	});

	it("continues footnote numbering and preserves CRLF", () => {
		const first = annotateMarkdown("One two three.\r\nFour five six.\r\n", [{ id: "ann_00000009", quote: "One two", note: "a" }]);
		const second = annotateMarkdown(first.text!, [{ id: "ann_0000000a", quote: "five six", note: "b\nc" }]);
		assert.ok(second.text!.includes("<mark>five six</mark>[^lh-2]"));
		assert.ok(second.text!.includes("[^lh-2]: b c (LearnHarness)"));
		assert.ok(!/(?<!\r)\n/.test(second.text!), "every line break stays CRLF");
	});

	it("refuses fenced code and passages that cross a blank line", () => {
		const fenced = annotateMarkdown("```\nconst x = 1;\n```\n", [{ id: "ann_0000000b", quote: "const x", note: "n" }]);
		assert.equal(fenced.text, null);
		assert.deepEqual(fenced.outcomes.map((o) => o.result === "failed" && o.failure), ["unsupported"]);
		const crossing = annotateMarkdown("First block ends.\n\nSecond block starts.\n", [{ id: "ann_0000000c", quote: "ends. Second block", note: "n" }]);
		assert.deepEqual(crossing.outcomes.map((o) => o.result === "failed" && o.failure), ["unsupported"]);
	});

	it("reports a missing passage as not-found", () => {
		const { text, outcomes } = annotateMarkdown("Nothing relevant.\n", [{ id: "ann_0000000d", quote: "absent", note: "n" }]);
		assert.equal(text, null);
		assert.deepEqual(outcomes.map((o) => o.result === "failed" && o.failure), ["not-found"]);
	});
});
