// Image-only test PDFs (no text layer), drawn with @napi-rs/canvas and assembled with pdf-lib.
//
//   node scripts/verify-rig/make-scan-pdf.mjs <out.pdf> [--rotated] [--highlight]
//
// Page 1 is upright with two printed lines at the places handlers/annotate.mjs boxes expect.
// --rotated    adds page 2, stored sideways and shown upright through /Rotate 90 (one line, "Sideways in the file")
// --highlight  adds a Highlight with a Persian note on page 1 that ends at the right margin, so pdf.js's note popup has no room on its right
import fs from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { degrees, PDFDocument, PDFHexString, PDFString } from "pdf-lib";

const [out, ...flags] = process.argv.slice(2);
if (!out) {
	console.error("usage: node scripts/verify-rig/make-scan-pdf.mjs <out.pdf> [--rotated] [--highlight]");
	process.exit(2);
}

function underlinedLine(ctx, text, x, baseline, width, size) {
	ctx.fillStyle = "#111";
	ctx.font = `${size}px serif`;
	ctx.fillText(text, x, baseline, width);
	ctx.fillStyle = "#bbb";
	ctx.fillRect(x, baseline + 6, width, 2);
}

const pdf = await PDFDocument.create();

const upright = createCanvas(600, 800);
const a = upright.getContext("2d");
a.fillStyle = "#fbf7ec";
a.fillRect(0, 0, 600, 800);
a.fillStyle = "#111";
a.font = "28px serif";
a.fillText("MEDITATION II", 60, 90);
underlinedLine(a, "I think therefore I am", 60, 225, 480, 44);
underlinedLine(a, "doubt everything", 60, 275, 276, 40);
const first = pdf.addPage([600, 800]);
first.drawImage(await pdf.embedPng(upright.toBuffer("image/png")), { x: 0, y: 0, width: 600, height: 800 });

if (flags.includes("--rotated")) {
	// Displayed 800×600; stored as that picture turned 90° counter-clockwise, shown with /Rotate 90.
	const shown = createCanvas(800, 600);
	const d = shown.getContext("2d");
	d.fillStyle = "#eef3fb";
	d.fillRect(0, 0, 800, 600);
	d.fillStyle = "#111";
	d.font = "28px serif";
	d.fillText("PAGE TWO", 100, 90);
	underlinedLine(d, "Sideways in the file", 100, 292, 600, 48);
	const stored = createCanvas(600, 800);
	const s = stored.getContext("2d");
	s.translate(0, 800);
	s.rotate(-Math.PI / 2);
	s.drawImage(shown, 0, 0);
	const second = pdf.addPage([600, 800]);
	second.setRotation(degrees(90));
	second.drawImage(await pdf.embedPng(stored.toBuffer("image/png")), { x: 0, y: 0, width: 600, height: 800 });
}

if (flags.includes("--highlight")) {
	const note = "قاعدهٔ روش شک = آزمون اهریمن. کوگیتو (کتاب ص ۳۷–۳۸ / PDF ص ۳۹–۴۰) می‌گذرد، چون فریب خوردن خودش اندیشیدن است. قیاسی با کبرای «هر آنچه می‌اندیشد وجود دارد» نمی‌گذرد.";
	const now = new Date();
	const highlight = pdf.context.obj({
		Type: "Annot",
		Subtype: "Highlight",
		F: 4,
		Rect: [40, 565, 565, 605],
		QuadPoints: [40, 605, 565, 605, 40, 565, 565, 565],
		C: [1, 0.85, 0.2],
		Contents: PDFHexString.fromText(note),
		T: PDFHexString.fromText("LearnHarness"),
		NM: PDFHexString.fromText("ann_00000001"),
		M: PDFString.fromDate(now),
		CreationDate: PDFString.fromDate(now),
	});
	first.node.addAnnot(pdf.context.register(highlight));
}

fs.writeFileSync(out, await pdf.save());
console.log(`wrote ${out}`);
