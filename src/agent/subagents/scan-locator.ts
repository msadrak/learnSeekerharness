import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import type { SessionDocument } from "../../core/documents.ts";
import {
	SCAN_READ_PAGES_PER_STEP,
	SCAN_SECTION_MAX_STEPS,
	SCAN_SECTION_MAX_TEXT_PAGES,
	type ScanSectionRequest,
	type ScanSectionResult,
} from "../../core/scan-section.ts";
import type { ScanPageReader } from "../documents/scan-pages.ts";
import type { PiEngine } from "../models.ts";
import { toToolResult } from "../tool-execute.ts";
import { healToolRecord } from "../tools/heal.ts";
import { parsePageSpec } from "./pdf-ops.ts";
import { runSubagent } from "./pi-run.ts";

/**
 * The section locator: a short loop on the scan-reader model that finds ONE
 * section of a scanned PDF by reading the contents and then only the pages it
 * needs, and delivers either its page range (the caller returns the cached
 * verbatim pages) or a focused summary. Reading is bounded by the page
 * reader's fresh-read budget and by SCAN_SECTION_MAX_STEPS.
 */

export const SCAN_LOCATOR_INSTRUCTIONS = `You find ONE section of a scanned document and deliver it. You cannot see the document directly: you read its pages with read_pages, which returns each page's text (machine-read from the scan, so it may contain errors).

Method:
1. Read the contents or index first — the first pages (up to 10) and, if there is none there, the last pages (up to 5).
2. Printed page numbers are not PDF page numbers: compare a page you have read with the number printed on it to find the offset, then jump to the pages where the section should start.
3. Confirm the start by its heading or opening lines, then read forward until the section ends. If the contents misled you, look at neighbouring pages before giving up.
4. Read only what you need. Every page you read costs time and money; never read the whole document.
5. Finish with exactly one delivery tool: deliver_section (the first and last page of the section), deliver_summary (a summary, with the pages cited), or deliver_not_found (what you looked at and why the section is not there).

The section is what the request names, not a neighbouring chapter that merely mentions it. Page ranges are inclusive and cover the whole section, including its first and last partial pages. A summary states only what the pages say, cites pages like (p. 12), and follows the requested focus.`;

const readPagesInput = Type.Object({
	pages: Type.String({ description: `PDF pages to read: "3", "2-5", "1,4,9" (at most ${SCAN_READ_PAGES_PER_STEP} per call)` }),
});
const deliverSectionInput = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 200, description: "The section's title as printed" }),
	firstPage: Type.Integer({ minimum: 1, description: "PDF page where the section starts" }),
	lastPage: Type.Integer({ minimum: 1, description: "PDF page where the section ends (inclusive)" }),
});
const deliverSummaryInput = Type.Object({
	summary: Type.String({ minLength: 1, maxLength: 8000, description: "The summary, citing pages like (p. 12)" }),
	pages: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 40, description: "The PDF pages the summary draws on" }),
});
const deliverNotFoundInput = Type.Object({
	note: Type.String({ minLength: 1, maxLength: 1000, description: "What you looked at and why the section is not in the document" }),
});

export interface ScanLocatorOptions {
	doc: SessionDocument;
	pageCount: number;
	reader: ScanPageReader;
	engine: PiEngine;
	request: ScanSectionRequest;
	signal?: AbortSignal;
	chatId?: string;
	/** Money channel: the locator's own model calls (page reads are billed through the reader). */
	onUsage?: (usage: Usage) => void;
}

const BLANK = "(blank or unreadable page)";

function pageBlock(page: { number: number; text: string }): string {
	return `--- Page ${page.number} ---\n\n${page.text.trim() === "" ? BLANK : page.text}`;
}

/** A locator tool: `run` receives the schema-typed input (the agent loop has already validated it) and returns the text the model reads.
 *  Not serverExecute: its 30 s per-call guard would cut a multi-page read; the turn's abort signal still reaches every model call. */
function locatorTool<P extends TSchema>(name: string, description: string, parameters: P, run: (input: Static<P>) => Promise<string>): AgentTool<any> {
	return {
		name,
		label: name,
		description,
		parameters,
		execute: async (_toolCallId, input: unknown) => toToolResult(await run(input as Static<P>)),
	};
}

export async function locateScanSection(options: ScanLocatorOptions): Promise<ScanSectionResult> {
	const { doc, pageCount, reader, engine, request } = options;
	let delivered: ScanSectionResult | null = null;

	const tools = healToolRecord({
		read_pages: locatorTool(
			"read_pages",
			`Read pages of the scanned document and get their text. At most ${SCAN_READ_PAGES_PER_STEP} pages per call; pages already read are free, new ones are paid for from a fixed budget.`,
			readPagesInput,
			async ({ pages }) => {
				const wanted = parsePageSpec(pages, pageCount).slice(0, SCAN_READ_PAGES_PER_STEP);
				if (wanted.length === 0) return `ERROR: no pages match "${pages}" (the document has ${pageCount}).`;
				const { pages: read, unread } = await reader.read(wanted);
				const blocks = read.map(pageBlock);
				if (unread.length > 0) blocks.push(`Pages ${unread.join(", ")}: NOT read — the page budget for this request is used up. Deliver what you have, or deliver_not_found.`);
				return blocks.join("\n\n");
			},
		),
		deliver_section: locatorTool(
			"deliver_section",
			"Deliver the section as its inclusive PDF page range (for a request that wants the section's text).",
			deliverSectionInput,
			async ({ title, firstPage, lastPage }) => {
				if (request.form !== "text") return "ERROR: the request wants a summary — use deliver_summary.";
				if (lastPage < firstPage || lastPage > pageCount) return `ERROR: pages must satisfy 1 ≤ firstPage ≤ lastPage ≤ ${pageCount}.`;
				const last = Math.min(lastPage, firstPage + SCAN_SECTION_MAX_TEXT_PAGES - 1);
				const range = Array.from({ length: last - firstPage + 1 }, (_, i) => firstPage + i);
				const { pages, unread } = await reader.read(range);
				if (unread.length > 0) {
					return `ERROR: pages ${unread.join(", ")} of that range are not read and the page budget is used up. Deliver a smaller range, or deliver_not_found.`;
				}
				delivered = {
					kind: "text",
					title,
					firstPage,
					lastPage: last,
					continues: lastPage > last,
					pages: pages.map(({ number, text }) => ({ number, text })),
				};
				return "Delivered.";
			},
		),
		deliver_summary: locatorTool(
			"deliver_summary",
			"Deliver a summary of the section (for a request that wants a summary).",
			deliverSummaryInput,
			async ({ summary, pages }) => {
				if (request.form !== "summary") return "ERROR: the request wants the section's text — use deliver_section.";
				delivered = { kind: "summary", summary, pages: [...new Set(pages)].filter((p) => p <= pageCount).sort((a, b) => a - b) };
				return "Delivered.";
			},
		),
		deliver_not_found: locatorTool(
			"deliver_not_found",
			"Report that the requested section is not in the document.",
			deliverNotFoundInput,
			async ({ note }) => {
				delivered = { kind: "not-found", note };
				return "Recorded.";
			},
		),
	});

	const prompt = [
		`Document: ${doc.name} (${pageCount} pages)`,
		`Section requested: ${request.topic}`,
		request.form === "text"
			? "Form: text — deliver the section's page range with deliver_section."
			: `Form: summary — deliver a summary with deliver_summary${request.focus ? `, focused on: ${request.focus}` : ""}.`,
	].join("\n");

	const { text, newMessages } = await runSubagent(Object.values(tools), {
		role: "scanReader",
		engine,
		systemPrompt: SCAN_LOCATOR_INSTRUCTIONS,
		prompt,
		maxTurns: SCAN_SECTION_MAX_STEPS,
		abortSignal: options.signal,
		onUsage: options.onUsage,
		chatId: options.chatId,
		shouldStop: () => delivered !== null,
	});

	if (delivered) return delivered;
	// Say what really ended it. A model that answers in plain words (a refusal, or a service notice such as
	// "this client version is no longer supported") stops after one turn; only a full run is a step-limit stop.
	const turns = newMessages.filter((m) => (m as { role?: string }).role === "assistant").length;
	const said = text.trim().replace(/\s+/g, " ").slice(0, 500);
	if (turns >= SCAN_SECTION_MAX_STEPS) return { kind: "not-found", note: `I did not finish locating it within ${SCAN_SECTION_MAX_STEPS} steps.` };
	return { kind: "not-found", note: said ? `The reader stopped without delivering and said: "${said}"` : "The reader stopped without delivering or saying anything." };
}
