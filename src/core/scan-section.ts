/**
 * Reading a section of a SCANNED PDF for the agent (browser-safe contracts).
 * The agent names a topic; the scan reader finds the pages and delivers the
 * section's verbatim text or a focused summary. Every page it reads is
 * cached, and nothing reads the whole file by default.
 */
import type { PageRegion, SessionDocument } from "./documents.ts";

/** The longest section handed back as text; a longer one is cut here and says where it continues. */
export const SCAN_SECTION_MAX_TEXT_PAGES = 15;
/** The locator's model turns per call. */
export const SCAN_SECTION_MAX_STEPS = 12;
/** Fresh (uncached) vision page reads per call. */
export const SCAN_SECTION_MAX_FRESH_PAGES = 30;
/** Pages one `read_pages` step may ask for. */
export const SCAN_READ_PAGES_PER_STEP = 8;
/** The whole call's ceiling (ms); the default 30 s tool guard is far too short for it. */
export const SCAN_SECTION_TIMEOUT_MS = 5 * 60_000;
/** Placing one passage on a scanned page (paint the page, one model call): its ceiling (ms). */
export const SCAN_PASSAGE_TIMEOUT_MS = 2 * 60_000;

/** One page's machine-read text as stored. `text` may be empty (a blank page). */
export interface ScanCachedPage {
	text: string;
	/** Provider-qualified model that read it ("provider:id"). */
	model: string;
	at: string;
}

/** A document's page transcripts (file-backed in src/store/scan-cache.ts). */
export interface ScanPageCache {
	get(page: number): ScanCachedPage | undefined;
	put(page: number, entry: ScanCachedPage): void;
}

export interface ScanSectionRequest {
	/** The section or topic as the learner or the document calls it. */
	topic: string;
	/** `text`: the section's verbatim text. `summary`: a summary focused on `focus`. */
	form: "text" | "summary";
	focus?: string;
}

export type ScanSectionResult =
	| {
			kind: "text";
			title: string;
			firstPage: number;
			lastPage: number;
			/** The section goes on past `lastPage` (it was cut at SCAN_SECTION_MAX_TEXT_PAGES). */
			continues: boolean;
			pages: { number: number; text: string }[];
	  }
	| { kind: "summary"; summary: string; pages: number[] }
	| { kind: "not-found"; note: string };

/** What the document tools get injected: the server-side section reader (the agent layer never imports the server). */
export type ScanSectionReader = (doc: SessionDocument, request: ScanSectionRequest, signal?: AbortSignal) => Promise<ScanSectionResult>;

/**
 * Where a quoted passage sits on a SCANNED page, for annotating it: one rectangle per printed line (fractions of the displayed page).
 * The server-side locator, injected like the section reader. A plain Error says why the passage could not be placed.
 */
export type ScanPassageLocator = (doc: SessionDocument, page: number, quote: string, signal?: AbortSignal) => Promise<PageRegion[]>;
