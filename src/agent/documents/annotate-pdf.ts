import { EncryptedPDFError, PDFDocument, PDFHexString, PDFString } from "pdf-lib";
import type { AnnotationFailure, PageRegion } from "../../core/documents.ts";
import { openPdfBytes } from "../subagents/pdf-ops.ts";
import { AUTHOR, failed, type AnnotationInput, type AnnotationOutcome } from "./annotation-types.ts";
import { locateInPdfPages, readPdfPages, type PdfTextItem } from "./text.ts";

const HIGHLIGHT_COLOR = [1, 0.85, 0.2];

/** Quad (x0,yHi, x1,yHi, x0,yLo, x1,yLo) for characters [from, to) of one upright text item. */
function quadFor(item: PdfTextItem, from: number, to: number): number[] | null {
	const [, b, c, d, e, f] = item.transform as [number, number, number, number, number, number];
	if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) return null; // rotated text
	const length = item.str.length;
	const h = Math.hypot(c, d);
	const x0 = e + (item.width * from) / length;
	const x1 = e + (item.width * to) / length;
	const yLo = f - 0.2 * h;
	const yHi = f + 0.8 * h;
	return [x0, yHi, x1, yHi, x0, yLo, x1, yLo];
}

/**
 * A page region (fractions of the displayed page from its top-left, the page's /Rotate applied — the viewer's coordinates) as
 * a quad in PDF user space: the crop box `box` is what pdf.js displays, `rotation` is the page's clockwise /Rotate.
 */
export function regionQuad(box: { x: number; y: number; width: number; height: number }, rotation: number, region: PageRegion): number[] {
	const angle = ((Math.round(rotation) % 360) + 360) % 360;
	const point = (u: number, v: number): [number, number] => {
		switch (angle) {
			case 90:
				return [box.x + v * box.width, box.y + u * box.height];
			case 180:
				return [box.x + (1 - u) * box.width, box.y + v * box.height];
			case 270:
				return [box.x + (1 - v) * box.width, box.y + (1 - u) * box.height];
			default:
				return [box.x + u * box.width, box.y + (1 - v) * box.height];
		}
	};
	const corners = [
		point(region.x, region.y),
		point(region.x + region.w, region.y),
		point(region.x, region.y + region.h),
		point(region.x + region.w, region.y + region.h),
	];
	const xs = corners.map((c) => c[0]);
	const ys = corners.map((c) => c[1]);
	const [x0, x1, yLo, yHi] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
	return [x0, yHi, x1, yHi, x0, yLo, x1, yLo];
}

type Target = { page: number; quads: number[] } | { failure: AnnotationFailure; message: string };

/** One page's pdf.js text items. */
interface PdfPageItems {
	number: number;
	items: PdfTextItem[];
}

/** Where a text-layer annotation goes: the quote's characters, found in the page text items. */
function textTarget(pages: readonly PdfPageItems[], item: AnnotationInput): Target {
	const found = locateInPdfPages(pages.map((p) => ({ number: p.number, segments: p.items.map((i) => i.str) })), item.quote, item.page);
	if (found.kind !== "found") return { failure: "not-found", message: "Passage not found in the file" };
	const textItems = pages.find((p) => p.number === found.page)!.items;
	const { start, end } = found.range;
	const quads: number[] = [];
	for (let s = start.segment; s <= end.segment; s++) {
		const textItem = textItems[s]!;
		const from = s === start.segment ? start.offset : 0;
		const to = s === end.segment ? end.offset : textItem.str.length;
		if (to <= from) continue;
		const quad = quadFor(textItem, from, to);
		if (quad === null) return { failure: "unsupported", message: "Rotated text cannot be annotated" };
		quads.push(...quad);
	}
	return quads.length === 0 ? { failure: "not-found", message: "Passage not found in the file" } : { page: found.page, quads };
}

/** Where a scanned-page annotation goes: the rectangles a vision model placed, on the page the proposal named. */
function regionTarget(doc: PDFDocument, item: AnnotationInput, regions: readonly PageRegion[]): Target {
	if (item.page === undefined || item.page < 1 || item.page > doc.getPageCount()) return { failure: "not-found", message: "Page not found in the file" };
	const page = doc.getPage(item.page - 1);
	const box = page.getCropBox();
	const rotation = page.getRotation().angle;
	return { page: item.page, quads: regions.flatMap((region) => regionQuad(box, rotation, region)) };
}

/** Write PDF Highlight annotations (author "LearnHarness"). Whole-file re-save: existing
 *  signatures are invalidated; encrypted PDFs are refused. `bytes` is null when nothing was written. */
export async function annotatePdf(
	bytes: Uint8Array,
	items: readonly AnnotationInput[],
	now: Date,
): Promise<{ bytes: Uint8Array | null; outcomes: AnnotationOutcome[] }> {
	let doc: PDFDocument;
	try {
		doc = await PDFDocument.load(bytes, { updateMetadata: false });
	} catch (err) {
		if (err instanceof EncryptedPDFError) {
			return { bytes: null, outcomes: items.map((i) => failed(i.id, "encrypted", "Cannot annotate an encrypted PDF")) };
		}
		throw err;
	}
	// Text-layer proposals find their characters through pdf.js; scanned-page ones carry their own rectangles.
	let pages: PdfPageItems[] = [];
	if (items.some((i) => !i.regions)) {
		// pdfjs may detach its input buffer: hand it a copy.
		const opened = await openPdfBytes(bytes.slice());
		try {
			pages = await readPdfPages(opened.doc);
		} finally {
			await opened.task.destroy();
		}
	}
	const outcomes: AnnotationOutcome[] = [];
	let written = 0;
	for (const item of items) {
		const target = item.regions ? regionTarget(doc, item, item.regions) : textTarget(pages, item);
		if ("failure" in target) {
			outcomes.push(failed(item.id, target.failure, target.message));
			continue;
		}
		const { quads } = target;
		const xs = quads.filter((_, i) => i % 2 === 0);
		const ys = quads.filter((_, i) => i % 2 === 1);
		const annotation = doc.context.obj({
			Type: "Annot",
			Subtype: "Highlight",
			F: 4,
			Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
			QuadPoints: quads,
			C: HIGHLIGHT_COLOR,
			Contents: PDFHexString.fromText(item.note),
			T: PDFHexString.fromText(AUTHOR),
			NM: PDFHexString.fromText(item.id),
			M: PDFString.fromDate(now),
			CreationDate: PDFString.fromDate(now),
		});
		doc.getPage(target.page - 1).node.addAnnot(doc.context.register(annotation));
		outcomes.push({ id: item.id, result: "written" });
		written++;
	}
	return { bytes: written > 0 ? await doc.save({ useObjectStreams: false }) : null, outcomes };
}
