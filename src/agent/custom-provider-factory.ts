/**
 * Builds a pi-ai Provider from a hand-declared custom endpoint
 * (custom-providers wave). The agent layer owns provider CONSTRUCTION; the
 * record (store) and the credential (credential store) arrive as plain
 * values/closures from the server composition — this module imports neither.
 *
 * Auth: the endpoint's key lives in pi-ai's credential store as a
 * `{type:"api_key"}` credential under the provider id; Models hands it to
 * `resolve()`. A KEYLESS endpoint (Ollama, LM Studio, vLLM …) is the normal
 * case, not an error: pi-ai's OpenAI/Anthropic/Gemini adapters all refuse
 * to build a client without SOME auth value, so a keyless provider resolves
 * to a harmless placeholder token the local server ignores.
 */

import { createProvider, type Api, type ApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { CUSTOM_MODEL_DEFAULTS, type CustomApiProtocol, type CustomModelDef, type CustomProviderDef } from "../core/custom-providers.ts";

/** Sent when the endpoint has no key: satisfies the SDKs' non-empty-auth
 *  requirement; keyless servers ignore it. */
export const KEYLESS_PLACEHOLDER = "not-needed";

const API_FACTORIES = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
	"google-generative-ai": googleGenerativeAIApi,
} satisfies Record<CustomApiProtocol, () => unknown>;

function toModel(def: CustomProviderDef, m: CustomModelDef): Model<Api> {
	const contextWindow = m.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow;
	return {
		id: m.id,
		name: m.name ?? m.id,
		api: def.api,
		provider: def.id,
		baseUrl: def.baseUrl,
		input: m.input ?? ["text"],
		reasoning: m.reasoning ?? false,
		// Self-hosted / gateway pricing is unknown: zero, never fabricated.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(m.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens, contextWindow),
	};
}

function customApiKeyAuth(def: CustomProviderDef): ApiKeyAuth {
	return {
		name: `${def.name} API key`,
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: `Enter the API key for ${def.name}` });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key: key.trim() };
		},
		// A custom endpoint is configured by existing: key optional.
		resolve: async ({ credential, signal }) => {
			signal.throwIfAborted();
			const token = credential?.key || KEYLESS_PLACEHOLDER;
			const source = credential?.key ? "stored credential" : "keyless";
			return def.authScheme === "bearer"
				? { auth: { headers: { Authorization: `Bearer ${token}` } }, source }
				: { auth: { apiKey: token }, source };
		},
	};
}

export function buildCustomProvider(def: CustomProviderDef): Provider {
	return createProvider({
		id: def.id,
		name: def.name,
		baseUrl: def.baseUrl,
		auth: { apiKey: customApiKeyAuth(def) },
		models: def.models.map((m) => toModel(def, m)),
		api: API_FACTORIES[def.api](),
	});
}
