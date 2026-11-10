/**
 * Region transcription (scanned PDFs): the learner draws a rectangle on a page,
 * the server paints just that crop, the scan-reader model turns it into text,
 * and the crop is stored as a chat image snapshot so the transcript card can
 * show what was read. The learner reviews the text before anything reaches the
 * teacher (the excerpt input carries it back).
 */
import { randomUUID } from "node:crypto";
import { renderPdfRegion, type RenderedPdfRegion } from "../agent/subagents/headless.ts";
import { runScanReader, ScanReaderError } from "../agent/subagents/scan-reader.ts";
import { documentFile } from "../agent/documents/registry.ts";
import { snapshotImageBytes } from "../agent/tools/learner-image.ts";
import type { PiEngine } from "../agent/models.ts";
import type { CallUsage } from "../core/contracts.ts";
import { parsePageRegion, REGION_EMPTY_CODE, REGION_NO_IMAGE_INPUT_CODE, type PageRegion } from "../core/documents.ts";
import { modelsNotConfigured, providerKeyMissing } from "../core/settings.ts";
import { documentOf } from "./documents.ts";
import { providerKeyPresent } from "./keys.ts";
import { callUsageOf } from "./scan-engine.ts";
import { resolveEngine } from "./role-engine.ts";
import { stores } from "./stores.ts";

/** A failed transcription with its HTTP shape (routes map it straight through). */
export class RegionError extends Error {
	constructor(
		readonly status: number,
		readonly body: { error: string; code?: string },
	) {
		super(body.error);
		this.name = "RegionError";
	}
}

export interface RegionTranscript {
	transcript: string;
	snapshotId: string;
	width: number;
	height: number;
}

export interface TranscribeRegionOptions {
	signal?: AbortSignal;
	/** Test seam: a scripted engine replaces the scanReader role's settings-resolved one. */
	engine?: PiEngine;
	/** Test seam: replaces the native page painter. */
	render?: (file: string, page: number, region: PageRegion) => Promise<RenderedPdfRegion>;
}

function parseBody(body: unknown): { page: number; region: PageRegion } {
	const o = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
	const region = o ? parsePageRegion(o.region) : null;
	if (!o || !Number.isInteger(o.page) || (o.page as number) < 1 || !region) {
		throw new RegionError(400, { error: "Body must be {page, region:{x,y,w,h}} with a page number and a rectangle inside the page." });
	}
	return { page: o.page as number, region };
}

/** POST /documents/[docId]/region: transcribe one rectangle of a PDF page. */
export async function transcribeRegion(chatId: string, docId: string, body: unknown, opts: TranscribeRegionOptions = {}): Promise<RegionTranscript> {
	const { page, region } = parseBody(body);
	const doc = documentOf(chatId, docId);
	if (doc.format !== "pdf") throw new RegionError(400, { error: "Regions can only be read from PDF documents." });

	const engine = opts.engine ?? resolveEngine("scanReader");
	if (!engine) throw new RegionError(503, modelsNotConfigured(["vision"]));
	if (!opts.engine && !providerKeyPresent(engine.model.provider)) {
		throw new RegionError(503, providerKeyMissing(engine.model.provider, ["vision"]));
	}
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	if (!engine.model.input.includes("image")) {
		throw new RegionError(422, {
			error: `${modelId} does not accept images. Pick an image-capable model for the vision slot or the Scan reader role in Settings.`,
			code: REGION_NO_IMAGE_INPUT_CODE,
		});
	}

	let rendered: RenderedPdfRegion;
	try {
		rendered = await (opts.render ?? renderPdfRegion)(documentFile(doc), page, region);
	} catch (err) {
		if (err instanceof RangeError) throw new RegionError(400, { error: err.message });
		throw err;
	}
	opts.signal?.throwIfAborted();

	// Billed work is logged whether or not the model produced usable text.
	const steps: CallUsage[] = [];
	let transcript: string;
	try {
		transcript = await runScanReader(rendered.png, {
			engine,
			abortSignal: opts.signal,
			chatId,
			onUsage: (usage) => steps.push(callUsageOf(usage)),
		});
	} catch (err) {
		if (err instanceof ScanReaderError) {
			if (err.kind === "empty") throw new RegionError(422, { error: err.message, code: REGION_EMPTY_CODE });
			throw new RegionError(422, { error: err.message });
		}
		if (err instanceof Error && err.name === "AbortError") throw err;
		throw new RegionError(502, { error: err instanceof Error ? err.message : "The scan reader failed." });
	} finally {
		if (steps.length > 0) {
			stores.chatStore.appendScanUsage(chatId, { id: randomUUID(), at: new Date().toISOString(), documentId: doc.id, page, model: modelId, steps });
		}
	}

	const snapshot = await snapshotImageBytes(rendered.png, opts.signal);
	stores.chatStore.saveImageSnapshot(chatId, snapshot.snapshotId, snapshot);
	return { transcript, snapshotId: snapshot.snapshotId, width: snapshot.width, height: snapshot.height };
}

/** Map a region failure to its HTTP response; null when it is not ours (the caller rethrows). */
export function regionErrorResponse(err: unknown): Response | null {
	if (err instanceof RegionError) return Response.json(err.body, { status: err.status, headers: { "Cache-Control": "no-store" } });
	if (err instanceof Error && err.name === "AbortError") return Response.json({ error: "Cancelled." }, { status: 499 });
	return null;
}
