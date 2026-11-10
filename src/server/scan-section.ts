/**
 * Scanned-section reading for the agent (the `read_scanned_section` tool's
 * server side): resolve the scan-reader engine fresh, gate it like every
 * per-need call (configured, key present, takes images), run the locator over
 * a cached page reader, and log the billed calls on the chat. The agent layer
 * never imports the server, so chat-handler injects this into the document
 * tools as a `ScanSectionReader`.
 */
import { randomUUID } from "node:crypto";
import { documentFile } from "../agent/documents/registry.ts";
import { ScanPageReader } from "../agent/documents/scan-pages.ts";
import { documentText } from "../agent/documents/text.ts";
import type { PiEngine } from "../agent/models.ts";
import { locateScanSection } from "../agent/subagents/scan-locator.ts";
import type { CallUsage } from "../core/contracts.ts";
import type { PageRegion, SessionDocument } from "../core/documents.ts";
import { SCAN_SECTION_MAX_FRESH_PAGES, type ScanSectionRequest, type ScanSectionResult } from "../core/scan-section.ts";
import { openScanCache, scanCacheId } from "../store/scan-cache.ts";
import { callUsageOf, scanReaderEngine } from "./scan-engine.ts";
import { stores } from "./stores.ts";
import type { RenderedPdfRegion } from "../agent/subagents/headless.ts";

export interface ReadScannedSectionOptions {
	signal?: AbortSignal;
	/** Test seam: a scripted engine replaces the scanReader role's settings-resolved one. */
	engine?: PiEngine;
	/** Test seam: replaces the native page painter. */
	render?: (file: string, page: number, region: PageRegion) => Promise<RenderedPdfRegion>;
}

/** Refusals are plain errors: the tool result tells the agent what to relay to the learner. */
export async function readScannedSection(
	chatId: string,
	doc: SessionDocument,
	request: ScanSectionRequest,
	options: ReadScannedSectionOptions = {},
): Promise<ScanSectionResult> {
	if (doc.format !== "pdf") throw new Error("Scanned-section reading works on PDF documents only.");
	const { engine, modelId } = scanReaderEngine(options.engine);

	const file = documentFile(doc);
	const pageCount = doc.pageCount ?? (await documentText(doc)).pages?.length ?? 0;
	if (pageCount < 1) throw new Error("This PDF has no pages.");

	const pageSteps = new Map<number, CallUsage[]>();
	const locatorSteps: CallUsage[] = [];
	const reader = new ScanPageReader({
		doc,
		file,
		pageCount,
		engine,
		cache: openScanCache(scanCacheId(doc, file)),
		maxFresh: SCAN_SECTION_MAX_FRESH_PAGES,
		signal: options.signal,
		chatId,
		render: options.render,
		onPageUsage: (page, usage) => pageSteps.set(page, [...(pageSteps.get(page) ?? []), callUsageOf(usage)]),
	});
	try {
		return await locateScanSection({
			doc,
			pageCount,
			reader,
			engine,
			request,
			signal: options.signal,
			chatId,
			onUsage: (usage) => locatorSteps.push(callUsageOf(usage)),
		});
	} finally {
		// Billed work is logged whether or not the section was found, or the call was cancelled.
		const at = new Date().toISOString();
		for (const [page, steps] of pageSteps) {
			stores.chatStore.appendScanUsage(chatId, { id: randomUUID(), at, documentId: doc.id, page, model: modelId, steps });
		}
		if (locatorSteps.length > 0) {
			stores.chatStore.appendScanUsage(chatId, { id: randomUUID(), at, documentId: doc.id, model: modelId, steps: locatorSteps });
		}
	}
}
