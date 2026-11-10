import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { processImage } from "../image-processing/index.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";

/**
 * The scan reader: ONE model call that turns a screenshot region of a scanned
 * page into Markdown text for the teacher. No tools, no loop — the learner
 * reviews the text before it is sent, so the call is deliberately plain.
 */

export const SCAN_READER_INSTRUCTIONS = `You are a transcription engine for scanned study material. You receive ONE image: a region cut from a page of a learner's document. Output only its content as Markdown:
- Transcribe all text exactly as written, in its original language and script, in reading order. Never translate, summarize, correct or complete it.
- Keep right-to-left text (Persian, Arabic) in logical order. Keep digits as printed.
- Write mathematics as LaTeX: $…$ inline, $$…$$ for display.
- Reproduce tables and lists as Markdown tables and lists; keep headings as headings.
- Render a figure, diagram or photo as one line: [figure: what it shows, including readable labels and captions].
- Mark anything you cannot read as [illegible]; never guess.
- If there is no readable content, output exactly: [no readable content]
No preamble, no commentary, no code fence.`;

/** The model's answer when the region holds nothing to read (the prompt's own sentinel). */
export const SCAN_READER_EMPTY = "[no readable content]";

export class ScanReaderError extends Error {
	constructor(
		message: string,
		readonly kind: "no-image-input" | "image-rejected" | "empty",
	) {
		super(message);
		this.name = "ScanReaderError";
	}
}

export interface ScanReaderOptions {
	engine: PiEngine;
	abortSignal?: AbortSignal;
	/** Money channel: one call per model request. */
	onUsage?: (usage: Usage) => void;
	chatId?: string;
}

/** The region's text. Throws ScanReaderError when the model cannot take images or finds nothing readable. */
export async function runScanReader(png: Uint8Array, opts: ScanReaderOptions): Promise<string> {
	const { engine } = opts;
	if (!engine.model.input.includes("image")) {
		throw new ScanReaderError(`${engine.model.provider}:${engine.model.id} does not accept images.`, "no-image-input");
	}
	const image = await processImage(Buffer.from(png), "image/png", { resizeOptions: engine.model.inputLimits?.images?.resize });
	opts.abortSignal?.throwIfAborted();
	if (!image.ok) throw new ScanReaderError(image.message, "image-rejected");
	const message: AgentMessage = {
		role: "user",
		content: [
			{ type: "text", text: "Transcribe this region." },
			{ type: "image", data: image.data, mimeType: image.mimeType },
		],
		timestamp: Date.now(),
	};
	const { text } = await runSubagent([], {
		role: "scanReader",
		engine,
		systemPrompt: SCAN_READER_INSTRUCTIONS,
		messages: [message],
		maxTurns: 1,
		abortSignal: opts.abortSignal,
		onUsage: opts.onUsage,
		chatId: opts.chatId,
	});
	const transcript = text.trim();
	if (transcript === "" || transcript === SCAN_READER_EMPTY) throw new ScanReaderError("No readable text in this region.", "empty");
	return transcript;
}
