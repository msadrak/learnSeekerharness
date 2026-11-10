/**
 * Placing a passage on a scanned page (the `propose_annotation` tool's scanned path): resolve the scan-reader engine, paint the
 * page, ask the boxer where the passage sits, and log the billed call on the chat. The agent layer never imports the server,
 * so chat-handler injects this into the document tools as a `ScanPassageLocator`.
 */
import { randomUUID } from "node:crypto";
import { documentFile } from "../agent/documents/registry.ts";
import type { PiEngine } from "../agent/models.ts";
import { renderPdfRegion, type RenderedPdfRegion } from "../agent/subagents/headless.ts";
import { locatePassageBoxes, ScanBoxerError } from "../agent/subagents/scan-boxer.ts";
import type { CallUsage } from "../core/contracts.ts";
import { WHOLE_PAGE, type PageRegion, type SessionDocument } from "../core/documents.ts";
import { callUsageOf, scanReaderEngine } from "./scan-engine.ts";
import { stores } from "./stores.ts";

export interface LocateScanPassageOptions {
	signal?: AbortSignal;
	/** Test seam: a scripted engine replaces the scanReader role's settings-resolved one. */
	engine?: PiEngine;
	/** Test seam: replaces the native page painter. */
	render?: (file: string, page: number, region: PageRegion) => Promise<RenderedPdfRegion>;
}

/** The passage's line boxes on page `page`. Refusals are plain errors: the tool result tells the agent what to relay to the learner. */
export async function locateScanPassage(
	chatId: string,
	doc: SessionDocument,
	page: number,
	quote: string,
	options: LocateScanPassageOptions = {},
): Promise<PageRegion[]> {
	if (doc.format !== "pdf") throw new Error("Scanned-page annotation works on PDF documents only.");
	const { engine, modelId } = scanReaderEngine(options.engine);
	let painted: RenderedPdfRegion;
	try {
		painted = await (options.render ?? renderPdfRegion)(documentFile(doc), page, WHOLE_PAGE);
	} catch (err) {
		if (err instanceof RangeError) throw new Error(err.message);
		throw err;
	}
	const steps: CallUsage[] = [];
	try {
		return await locatePassageBoxes(painted.png, quote, {
			engine,
			abortSignal: options.signal,
			chatId,
			onUsage: (usage) => steps.push(callUsageOf(usage)),
		});
	} catch (err) {
		if (err instanceof ScanBoxerError) {
			if (err.kind === "not-found") throw new Error(`The scan reader could not find that passage on page ${page}. Check the page number and the quote, or tell the learner you cannot place it.`);
			throw new Error(`The scan reader could not place the passage on page ${page}: ${err.message}`);
		}
		throw err;
	} finally {
		// Billed work is logged whether or not the passage was placed, or the call was cancelled.
		if (steps.length > 0) {
			stores.chatStore.appendScanUsage(chatId, { id: randomUUID(), at: new Date().toISOString(), documentId: doc.id, page, model: modelId, steps });
		}
	}
}
