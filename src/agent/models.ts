import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	type Api,
	type CacheRetention,
	type Model,
	type CredentialStore,
	type Models,
	type MutableModels,
	type Provider,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { lazyApi, lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { antigravityProvider, geminiCliProvider } from "./google-cloudcode/index.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { createClaudeCodeProvider } from "./claude-code/provider.ts";
import { streamClaudeCode } from "./claude-code/stream.ts";
import { nativeSubscriptionId, nativeSubscriptionModel } from "./subscription-bridge.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/archive/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The initially resolved (config-or-settings, CLAMPED) thinking level.
	 *  Custom streams re-resolve the original preference per operation. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: MutableModels | undefined;

/** The Google Cloud Code subscription providers (Gemini CLI login,
 *  Antigravity login) registered next to pi-ai's builtins. */
const CLOUDCODE_PROVIDER_IDS = ["google-gemini-cli", "google-antigravity"] as const;

/** The server composition's hand-off to the agent layer (the layering law:
 *  agent never imports store/server). Carries the file-backed credential
 *  store (OAuth subscription logins + custom-provider keys) and the
 *  user-declared custom providers, with a cheap change stamp so hand-edits
 *  to the providers file hot-reload without a restart. */
export interface ProviderSource {
	credentials: CredentialStore;
	/** Cheap (stat-level) change detector; providers() re-runs when it moves. */
	stamp(): string;
	providers(): Provider[];
}
const SOURCE_KEY = Symbol.for("lh.providerSource");
let appliedStamp: string | undefined;
let appliedIds: string[] = [];

/** Install the process-wide source. The collection is rebuilt so its
 *  credential store is the source's (idempotent: same source = no-op). */
export function registerProviderSource(source: ProviderSource): void {
	const g = globalThis as Record<symbol, ProviderSource | undefined>;
	if (g[SOURCE_KEY] === source) return;
	g[SOURCE_KEY] = source;
	collection = undefined;
}

/** Re-apply the source's providers when its stamp moved: drop the ones we
 *  added last time, add the current ones (a removed custom provider
 *  disappears; an edited one is replaced). */
function syncSourceProviders(target: MutableModels, source: ProviderSource): void {
	const stamp = source.stamp();
	if (stamp === appliedStamp) return;
	for (const id of appliedIds) target.deleteProvider(id);
	const providers = source.providers();
	for (const provider of providers) target.setProvider(provider);
	appliedIds = providers.map((p) => p.id);
	appliedStamp = stamp;
}

/** Upstream's injected custom-endpoint source (settings-backed single
 *  OpenAI-compatible provider). Coexists with the file-backed
 *  ProviderSource above. */
interface CustomEndpointSource {
	sync(models: MutableModels): void;
	isCustom(id: string): boolean;
}
let providerSource: CustomEndpointSource | undefined;

/** Configuration IO is injected by the server; the agent never imports stores. */
export function configureProviderSource(source: CustomEndpointSource): void {
	// Server module re-evaluation can replace the source while this collection
	// survives. Retire only the previous source's routes, not built-ins.
	if (collection && providerSource) {
		for (const provider of collection.getProviders()) {
			if (providerSource.isCustom(provider.id)) collection.deleteProvider(provider.id);
		}
	}
	providerSource = source;
}

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself: stored
 *  credentials (subscription OAuth, custom-provider keys) first, then the
 *  environment (the keys seam reflects file-saved keys into env), and a
 *  provider with no credential simply fails its stream with "not
 *  configured" — honest, late, and unreachable through the picker, which
 *  gates on keyPresent. User-declared custom providers ride in via the
 *  registered ProviderSource and hot-reload when it changes. */
export function piModels(): MutableModels {
	const source = (globalThis as Record<symbol, ProviderSource | undefined>)[SOURCE_KEY];
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY, credentials: source?.credentials });
		for (const provider of builtinProviders()) {
			// Keep the native Bedrock implementation reachable by standalone tracing.
			// Pi's default Node-only loader hides this import from bundlers. Only
			// replace its lazy forwarding; preserve the native factory's auth/catalog.
			collection.setProvider(provider.id === "amazon-bedrock"
				? { ...provider, ...lazyApi(() => import("@earendil-works/pi-ai/api/bedrock-converse-stream")) }
				: provider);
		}
		collection.setProvider(createClaudeCodeProvider(streamClaudeCode));
		collection.setProvider(geminiCliProvider());
		collection.setProvider(antigravityProvider());
		appliedStamp = undefined;
		appliedIds = [];
	}
	if (source) syncSourceProviders(collection, source);
	providerSource?.sync(collection);
	return collection;
}

/** Provider ids a user-declared custom provider may NOT take: every
 *  builtin catalog provider, the Google Cloud Code subscription pair, and
 *  the app's ChatGPT desktop pseudo-provider. Model pins are keyed by
 *  provider id, so a custom provider must never shadow a real one. */
export function reservedProviderIds(): Set<string> {
	const ids = new Set(builtinProviders().map((p) => p.id));
	for (const id of CLOUDCODE_PROVIDER_IDS) ids.add(id);
	ids.add("chatgpt");
	return ids;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle, cacheRetention?: () => CacheRetention | undefined): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	const registeredModel = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : nativeId ? nativeSubscriptionModel(spec.provider, spec.id) : models.getModel(spec.provider, spec.id);
	const custom = providerSource?.isCustom(spec.provider) ?? false;
	// Custom endpoint owners authorize image attempts independently of sparse
	// discovery metadata. Never promote the registered/catalog capabilities.
	const permitImages = (value: Model<Api>): Model<Api> => ({ ...value, input: ["text", "image"] });
	const model = custom && registeredModel ? permitImages(registeredModel) : registeredModel;
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const thinkingPreference = spec.thinkingLevel;
	const level = thinkingPreference
		? clampThinkingLevel(model, thinkingPreference)
		: defaultThinkingLevel(model);
	// A lesson's agent loop can stay alive through many tool calls. Remember
	// only that this is a custom route, never its configuration for that run.
	return {
		model,
		level,
		// The agent loop forwards state.thinkingLevel as `reasoning` (undefined
		// = off on pi-ai's scale). Built-ins keep the factory clamp; custom
		// requests re-resolve thinking against their current metadata below.
		streamFn: (requestModel, context, options) => {
			// Read the slot preference for every operation, not just engine creation.
			// Unset adds NOTHING: native defaults/env and explicit caller options survive.
			const retention = cacheRetention?.();
			const requestOptions = {
				...options,
				...(retention !== undefined ? { cacheRetention: retention } : {}),
				reasoning: level === "off" ? undefined : level,
			};
			if (custom) {
				// Revalidate before EVERY upstream model operation, including later
				// tool-loop steps. Resolve thinking from the ORIGINAL preference (or
				// existing default order), not a previous metadata snapshot's clamp.
				// Pi retains the setup of an operation already in flight.
				const current = piModels();
				const currentModel = current.getModel(spec.provider, spec.id);
				if (!currentModel) return lazyStream(requestModel, async () => { throw new Error("The selected custom model is unavailable."); });
				const currentLevel = thinkingPreference
					? clampThinkingLevel(currentModel, thinkingPreference)
					: defaultThinkingLevel(currentModel);
				return current.streamSimple(permitImages(currentModel), context, { ...requestOptions, reasoning: currentLevel === "off" ? undefined : currentLevel });
			}
			const purpose = typeof background === "function" ? background : () => background;
			const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
			return stream(requestModel, context, requestOptions);
		},
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
