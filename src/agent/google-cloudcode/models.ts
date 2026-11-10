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
import { Type } from "typebox";
import { Value } from "typebox/value";

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

/** The models Antigravity is known to serve, with the pricing estimates and thinking maps the app keeps for them. Google's live
 *  listing (below) decides which of these exist for an account; this is also the list shown until the first listing arrives. */
const ANTIGRAVITY_SPECS: readonly Spec[] = [
	{ id: "claude-opus-4-5-thinking", name: "Claude Opus 4.5 Thinking (Antigravity)", reasoning: true, cost: cost(5, 25, 0.5, 6.25), contextWindow: 200000, maxTokens: 64000 },
	{ id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking (Antigravity)", reasoning: true, cost: cost(5, 25, 0.5, 6.25), contextWindow: 200000, maxTokens: 128000 },
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (Antigravity)", reasoning: false, cost: cost(3, 15, 0.3, 3.75), contextWindow: 200000, maxTokens: 64000 },
	{ id: "claude-sonnet-4-5-thinking", name: "Claude Sonnet 4.5 Thinking (Antigravity)", reasoning: true, cost: cost(3, 15, 0.3, 3.75), contextWindow: 200000, maxTokens: 64000 },
	{ id: "gemini-3-flash", name: "Gemini 3 Flash (Antigravity)", reasoning: true, cost: cost(0.5, 3, 0.5, 0), contextWindow: 1048576, maxTokens: 65535, thinkingLevelMap: GEMINI_3_FLASH_LEVELS },
	{ id: "gemini-3-pro-high", name: "Gemini 3 Pro High (Antigravity)", reasoning: true, cost: cost(2, 12, 0.2, 2.375), contextWindow: 1048576, maxTokens: 65535, thinkingLevelMap: GEMINI_3_PRO_LEVELS },
	{ id: "gemini-3-pro-low", name: "Gemini 3 Pro Low (Antigravity)", reasoning: true, cost: cost(2, 12, 0.2, 2.375), contextWindow: 1048576, maxTokens: 65535, thinkingLevelMap: GEMINI_3_PRO_LEVELS },
	{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B Medium (Antigravity)", reasoning: false, image: false, cost: cost(0.09, 0.36, 0, 0), contextWindow: 131072, maxTokens: 32768 },
];

export const ANTIGRAVITY_MODELS: readonly CloudCodeModel[] = build(ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SPECS);

// ─── Live listing ────────────────────────────────────────────────────────────

/** Conservative limits for a model Google lists without them. */
const UNKNOWN_CONTEXT_WINDOW = 200_000;
const UNKNOWN_MAX_OUTPUT = 32_768;

/** The parts of Google's `fetchAvailableModels` answer this app reads (the shape is taken from third-party clients of the endpoint). */
const AntigravityListing = Type.Object({
	models: Type.Record(Type.String(), Type.Unknown()),
	agentModelSorts: Type.Array(Type.Object({ groups: Type.Optional(Type.Array(Type.Object({ modelIds: Type.Optional(Type.Array(Type.String())) }))) })),
});
const ListedModel = Type.Object({
	displayName: Type.Optional(Type.String()),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
	maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
	supportsImages: Type.Optional(Type.Boolean()),
	disabled: Type.Optional(Type.Boolean()),
});

/**
 * The models this account can pick, from Google's `fetchAvailableModels` answer: the ids Antigravity's own picker shows
 * (`agentModelSorts`, in its order) that exist and are not `disabled`. Internal and autocomplete models never appear in those
 * groups. A model the app knows keeps its pricing estimate and thinking map; an unknown one is taken as it is listed —
 * no thinking setting (its tier is in its id), no price, and image input only when Google says so. An answer of an
 * unexpected shape yields no models; a single malformed entry is skipped.
 */
export function antigravityModelsFromListing(listing: unknown): CloudCodeModel[] {
	if (!Value.Check(AntigravityListing, listing)) return [];
	const ids: string[] = [];
	for (const sort of listing.agentModelSorts) {
		for (const group of sort.groups ?? []) {
			for (const id of group.modelIds ?? []) if (!ids.includes(id)) ids.push(id);
		}
	}
	const known = new Map(ANTIGRAVITY_SPECS.map((spec) => [spec.id, spec]));
	const specs: Spec[] = [];
	for (const id of ids) {
		const entry: unknown = listing.models[id];
		if (!Value.Check(ListedModel, entry) || entry.disabled === true) continue;
		const base = known.get(id);
		specs.push({
			id,
			name: `${entry.displayName?.trim() || id} (Antigravity)`,
			reasoning: base?.reasoning ?? false,
			image: entry.supportsImages ?? (base ? base.image !== false : false),
			cost: base?.cost ?? FREE,
			contextWindow: entry.maxTokens ?? base?.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
			maxTokens: entry.maxOutputTokens ?? base?.maxTokens ?? UNKNOWN_MAX_OUTPUT,
			...(base?.thinkingLevelMap ? { thinkingLevelMap: base.thinkingLevelMap } : {}),
		});
	}
	return build(ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_DAILY_ENDPOINT, specs);
}
