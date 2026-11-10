import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parsePageRegion, type PageRegion } from "../../core/documents.ts";
import { processImage } from "../image-processing/index.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";

/**
 * The scan boxer: ONE model call that places a passage on a scanned page. It gets the page image and the passage as the
 * teacher read it, and answers with one box per printed line on a 0–1000 grid (the convention Gemini models are trained on).
 * The learner sees the boxes and accepts or rejects them before anything is written, so the call is deliberately plain.
 */

/** Grid the model answers on. */
const GRID = 1000;
/** More lines than this is not one passage: refuse rather than highlight half the page. */
export const SCAN_BOXER_MAX_LINES = 40;

export const SCAN_BOXER_INSTRUCTIONS = `You locate a passage on ONE page of a scanned study document. You receive the page image and a passage that a machine transcribed from it, so the passage may differ slightly from the print (spelling, diacritics, line breaks).
Reply with one JSON object and nothing else:
{"found": true, "lines": [[ymin, xmin, ymax, xmax], ...]}
- One box per printed line of the passage, in reading order. Each box hugs the ink of that line, and only the part of the line that belongs to the passage.
- Coordinates are integers on a 0–1000 grid over the WHOLE page image: y runs down from the top edge, x runs right from the left edge. This holds for right-to-left text too.
- If the passage is not on this page, reply {"found": false}.
No commentary, no code fence.`;

export class ScanBoxerError extends Error {
	constructor(
		message: string,
		readonly kind: "no-image-input" | "image-rejected" | "not-found" | "unreadable",
	) {
		super(message);
		this.name = "ScanBoxerError";
	}
}

const Answer = Type.Object({
	found: Type.Boolean(),
	lines: Type.Optional(Type.Array(Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]))),
});

/** Largest share of the page the boxes together may cover; a model that boxes the whole page has not located anything. */
const MAX_COVERED = 0.9;

/** The answer's boxes as page regions; throws ScanBoxerError when it says "not found" or is unusable. */
export function parseBoxerAnswer(text: string): PageRegion[] {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	let answer: unknown;
	try {
		answer = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
	} catch {
		throw new ScanBoxerError("The model's answer was not JSON.", "unreadable");
	}
	if (!Value.Check(Answer, answer)) throw new ScanBoxerError("The model's answer had an unexpected shape.", "unreadable");
	if (!answer.found) throw new ScanBoxerError("The passage is not on this page.", "not-found");
	const lines = answer.lines ?? [];
	if (lines.length === 0 || lines.length > SCAN_BOXER_MAX_LINES) {
		throw new ScanBoxerError(`The model placed the passage on ${lines.length} lines; a passage has 1 to ${SCAN_BOXER_MAX_LINES}.`, "unreadable");
	}
	const regions: PageRegion[] = [];
	for (const [ymin, xmin, ymax, xmax] of lines) {
		const clamp = (n: number) => Math.min(GRID, Math.max(0, n));
		const region = parsePageRegion({ x: clamp(xmin) / GRID, y: clamp(ymin) / GRID, w: (clamp(xmax) - clamp(xmin)) / GRID, h: (clamp(ymax) - clamp(ymin)) / GRID });
		if (!region) throw new ScanBoxerError("The model returned an empty or inverted box.", "unreadable");
		regions.push(region);
	}
	const covered = regions.reduce((sum, r) => sum + r.w * r.h, 0);
	if (covered > MAX_COVERED) throw new ScanBoxerError("The model boxed nearly the whole page, which is not a located passage.", "unreadable");
	return regions;
}

export interface ScanBoxerOptions {
	engine: PiEngine;
	abortSignal?: AbortSignal;
	/** Money channel: one call per model request. */
	onUsage?: (usage: Usage) => void;
	chatId?: string;
}

/** Where `quote` sits on the page image `png`. Throws ScanBoxerError when the model cannot take images, cannot find it, or answers unusably. */
export async function locatePassageBoxes(png: Uint8Array, quote: string, opts: ScanBoxerOptions): Promise<PageRegion[]> {
	const { engine } = opts;
	if (!engine.model.input.includes("image")) {
		throw new ScanBoxerError(`${engine.model.provider}:${engine.model.id} does not accept images.`, "no-image-input");
	}
	const image = await processImage(Buffer.from(png), "image/png", { resizeOptions: engine.model.inputLimits?.images?.resize });
	opts.abortSignal?.throwIfAborted();
	if (!image.ok) throw new ScanBoxerError(image.message, "image-rejected");
	const message: AgentMessage = {
		role: "user",
		content: [
			{ type: "text", text: `Passage to locate:\n${quote}` },
			{ type: "image", data: image.data, mimeType: image.mimeType },
		],
		timestamp: Date.now(),
	};
	const { text } = await runSubagent([], {
		role: "scanReader",
		engine,
		systemPrompt: SCAN_BOXER_INSTRUCTIONS,
		messages: [message],
		maxTurns: 1,
		abortSignal: opts.abortSignal,
		onUsage: opts.onUsage,
		chatId: opts.chatId,
	});
	return parseBoxerAnswer(text);
}
