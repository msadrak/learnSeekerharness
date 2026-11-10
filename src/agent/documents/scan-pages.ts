import type { Usage } from "@earendil-works/pi-ai";
import { WHOLE_PAGE, type PageRegion, type SessionDocument } from "../../core/documents.ts";
import type { ScanPageCache } from "../../core/scan-section.ts";
import type { PiEngine } from "../models.ts";
import { renderPdfRegion, type RenderedPdfRegion } from "../subagents/headless.ts";
import { runScanReader, ScanReaderError } from "../subagents/scan-reader.ts";
import { documentText } from "./text.ts";

/** Vision page reads in flight at once. */
const PARALLEL_READS = 4;

export type PageSource = "text-layer" | "cache" | "vision";

export interface ReadPage {
	number: number;
	/** Empty for a blank or unreadable page. */
	text: string;
	source: PageSource;
}

export interface ScanPageReaderOptions {
	doc: SessionDocument;
	file: string;
	pageCount: number;
	engine: PiEngine;
	cache: ScanPageCache;
	/** Fresh (uncached) vision reads this reader may start — the call's page budget. */
	maxFresh: number;
	signal?: AbortSignal;
	chatId?: string;
	/** Money channel: one call per model request, with the page it paid for. */
	onPageUsage?: (page: number, usage: Usage) => void;
	/** Test seam: replaces the native page painter. */
	render?: (file: string, page: number, region: PageRegion) => Promise<RenderedPdfRegion>;
}

/**
 * The pages of a scanned PDF as text, read only when asked: a page's own text
 * layer if it has one, else the cached transcript, else ONE fresh vision read
 * (cached afterwards). Fresh reads are counted against `maxFresh`, so nothing
 * can turn into whole-file transcription; pages past the budget come back
 * `unread`.
 */
export class ScanPageReader {
	#fresh = 0;
	readonly #options: ScanPageReaderOptions;

	constructor(options: ScanPageReaderOptions) {
		this.#options = options;
	}

	get freshLeft(): number {
		return this.#options.maxFresh - this.#fresh;
	}

	async read(pages: readonly number[]): Promise<{ pages: ReadPage[]; unread: number[] }> {
		const { doc, pageCount, cache } = this.#options;
		for (const page of pages) {
			if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new RangeError(`Page ${page} is outside 1–${pageCount}`);
		}
		const layer = (await documentText(doc)).pages;
		const found = new Map<number, ReadPage>();
		const missing: number[] = [];
		for (const number of new Set(pages)) {
			const layerText = layer?.[number - 1]?.text ?? "";
			const cached = cache.get(number);
			if (layerText.trim() !== "") found.set(number, { number, text: layerText, source: "text-layer" });
			else if (cached) found.set(number, { number, text: cached.text, source: "cache" });
			else missing.push(number);
		}
		const affordable = missing.slice(0, Math.max(0, this.freshLeft));
		for (let start = 0; start < affordable.length; start += PARALLEL_READS) {
			this.#options.signal?.throwIfAborted();
			const batch = affordable.slice(start, start + PARALLEL_READS);
			this.#fresh += batch.length;
			for (const page of await Promise.all(batch.map((number) => this.#readFresh(number)))) found.set(page.number, page);
		}
		return {
			pages: [...found.values()].sort((a, b) => a.number - b.number),
			unread: missing.slice(affordable.length),
		};
	}

	async #readFresh(number: number): Promise<ReadPage> {
		const { file, engine, cache, signal, chatId, onPageUsage, render } = this.#options;
		const painted = await (render ?? renderPdfRegion)(file, number, WHOLE_PAGE);
		let text: string;
		try {
			text = await runScanReader(painted.png, {
				engine,
				abortSignal: signal,
				chatId,
				onUsage: (usage) => onPageUsage?.(number, usage),
			});
		} catch (err) {
			// A page with nothing to read is a real answer: store it so it is not bought again.
			if (!(err instanceof ScanReaderError && err.kind === "empty")) throw err;
			text = "";
		}
		cache.put(number, { text, model: `${engine.model.provider}:${engine.model.id}`, at: new Date().toISOString() });
		return { number, text, source: "vision" };
	}
}
