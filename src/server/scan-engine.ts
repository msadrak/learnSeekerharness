/**
 * What every scan-reader call on the server shares: the engine the `scanReader` role resolves to — configured, key present,
 * takes images — and the conversion of a model call's usage into the shape the chat's scan log stores.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../agent/models.ts";
import type { CallUsage } from "../core/contracts.ts";
import { providerKeyMissing } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";
import { resolveEngine } from "./role-engine.ts";

export function callUsageOf(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		reasoningTokens: usage.reasoning ?? 0,
	};
}

/**
 * The scan reader's engine and its provider-qualified id, or a plain Error the tool result relays to the learner.
 * `override` is the test seam: a scripted engine replaces the role's settings-resolved one (and skips the key check).
 */
export function scanReaderEngine(override?: PiEngine): { engine: PiEngine; modelId: string } {
	const engine = override ?? resolveEngine("scanReader");
	if (!engine) {
		throw new Error("No scan-reading model is configured. Ask the learner to pick an image-capable model for the vision tier or the Scan reader role in Settings.");
	}
	if (!override && !providerKeyPresent(engine.model.provider)) {
		throw new Error(`${providerKeyMissing(engine.model.provider, ["vision"]).error} Ask the learner to connect it in Settings.`);
	}
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	if (!engine.model.input.includes("image")) {
		throw new Error(`${modelId}, set for scan reading, does not accept images. Ask the learner to pick an image-capable model for the vision tier or the Scan reader role in Settings.`);
	}
	return { engine, modelId };
}
