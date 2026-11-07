/**
 * Static model lists for the two Cloud Code Assist providers, ported from
 * @mariozechner/pi-ai@0.55.0's generated catalog (`google-gemini-cli` and
 * `google-antigravity`). Subscription-backed, so Gemini CLI costs are 0.
 *
 * Both providers speak the same wire protocol, so every model carries the same
 * custom `api` id; the provider id (not the api id) selects the endpoint,
 * headers and request quirks.
 */
import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Custom pi-ai `Api` id for the Cloud Code Assist protocol (same value the 0.55 catalog used, so persisted transcripts stay "same model"). */
export const CLOUDCODE_API = "google-gemini-cli";
export const GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";

export const CLOUDCODE_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

type CloudCodeModel = Model<typeof CLOUDCODE_API>;
type Cost = CloudCodeModel["cost"];

/** Gemini 3 Pro: only LOW/HIGH exist; pi levels collapse onto them (as the 0.55 provider did). Thinking cannot be disabled. */
const GEMINI_3_PRO_LEVELS: ThinkingLevelMap = { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: null, max: null };
/** Gemini 3 Flash: MINIMAL..HIGH map 1:1. Thinking cannot be disabled. */
const GEMINI_3_FLASH_LEVELS: ThinkingLevelMap = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };

const FREE: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const cost = (input: number, output: number, cacheRead: number, cacheWrite: number): Cost => ({ input, output, cacheRead, cacheWrite });

interface Spec {
	id: string;
	name: string;
	reasoning: boolean;
	image?: boolean;
	cost: Cost;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
}

function build(provider: string, baseUrl: string, specs: readonly Spec[]): CloudCodeModel[] {
	return specs.map((spec) => ({
		id: spec.id,
		name: spec.name,
		api: CLOUDCODE_API,
		provider,
		baseUrl,
		reasoning: spec.reasoning,
		...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
		input: spec.image === false ? ["text"] : ["text", "image"],
		cost: spec.cost,
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
	}));
}

export const GEMINI_CLI_MODELS: readonly CloudCodeModel[] = build(GEMINI_CLI_PROVIDER_ID, CLOUDCODE_ENDPOINT, [
	{ id: "gemini-2.0-flash", name: "Gemini 2.0 Flash (Cloud Code Assist)", reasoning: false, cost: FREE, contextWindow: 1048576, maxTokens: 8192 },
	{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (Cloud Code Assist)", reasoning: true, cost: FREE, contextWindow: 1048576, maxTokens: 65535 },
	{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Cloud Code Assist)", reasoning: true, cost: FREE, contextWindow: 1048576, maxTokens: 65535 },
	{ id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview (Cloud Code Assist)", reasoning: true, cost: FREE, contextWindow: 1048576, maxTokens: 65535, thinkingLevelMap: GEMINI_3_FLASH_LEVELS },
	{ id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview (Cloud Code Assist)", reasoning: true, cost: FREE, contextWindow: 1048576, maxTokens: 65535, thinkingLevelMap: GEMINI_3_PRO_LEVELS },
]);

export const ANTIGRAVITY_MODELS: readonly CloudCodeModel[] = build(ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_DAILY_ENDPOINT, [
	{ id: "claude-opus-4-5-thinking", name: "Claude Opus 4.5 Thinking (Antigravity)", reasoning: true, cost: cost(5, 25, 0.5, 6.25), contextWindow: 200000, maxTokens: 64000 },
	{ id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking (Antigravity)", reasoning: true, cost: cost(5, 25, 0.5, 6.25), contextWindow: 200000, maxTokens: 128000 },
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (Antigravity)", reasoning: false, cost: cost(3, 15, 0.3, 3.75), contextWindow: 200000, maxTokens: 64000 },
	{ id: "claude-sonnet-4-5-thinking", name: "Claude Sonnet 4.5 Thinking (Antigravity)", reasoning: true, cost: cost(3, 15, 0.3, 3.75), contextWindow: 200000, maxTokens: 64000 },
	{ id: "gemini-3-flash", name: "Gemini 3 Flash (Antigravity)", reasoning: true, cost: cost(0.5, 3, 0.5, 0), contextWindow: 1048576, maxTokens: 65535, thinkingLevelMap: GEMINI_3_FLASH_LEVELS },
	{ id: "gemini-3-pro-high", name: "Gemini 3 Pro High (Antigravity)", reasoning: true, cost: cost(2, 12, 0.2, 2.375), contextWindow: 1048576, maxTokens: 65535, thinkingLevelMap: GEMINI_3_PRO_LEVELS },
	{ id: "gemini-3-pro-low", name: "Gemini 3 Pro Low (Antigravity)", reasoning: true, cost: cost(2, 12, 0.2, 2.375), contextWindow: 1048576, maxTokens: 65535, thinkingLevelMap: GEMINI_3_PRO_LEVELS },
	{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B Medium (Antigravity)", reasoning: false, image: false, cost: cost(0.09, 0.36, 0, 0), contextWindow: 131072, maxTokens: 32768 },
]);
