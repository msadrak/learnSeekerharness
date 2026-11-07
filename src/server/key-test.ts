/**
 * Live key probe behind POST /api/keys/:id/test. One cheap authenticated GET
 * against the provider's own API proves the stored key works. The key is
 * only ever placed in the outgoing request — never in the result or a log.
 */

import { piModels } from "../agent/models.ts";
import { AUTH_PROVIDER_KEYS, type KeyTestResult } from "../core/auth-keys.ts";
import { keyValue } from "./keys.ts";

/** The slice of a pi-ai model the probe needs. */
export interface ProbeModel {
	api: string;
	baseUrl: string;
	provider: string;
	headers?: Record<string, string>;
}

export interface ProbeRequest {
	url: string;
	headers: Record<string, string>;
}

const PROBE_TIMEOUT_MS = 10_000;

/** The request that authenticates `key` against `model`'s provider, or null
 *  when the API family has no known cheap probe. Auth headers override any
 *  provider headers. */
export function probeRequestFor(model: ProbeModel, key: string): ProbeRequest | null {
	const base = model.baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = { ...(model.headers ?? {}) };
	// OpenRouter's /models is public, so it cannot prove a key.
	if (model.provider === "openrouter") {
		return { url: "https://openrouter.ai/api/v1/key", headers: { ...headers, Authorization: `Bearer ${key}` } };
	}
	switch (model.api) {
		case "openai-completions":
		case "openai-responses":
			return { url: `${base}/models`, headers: { ...headers, Authorization: `Bearer ${key}` } };
		case "mistral-conversations":
			return { url: `${base}/v1/models`, headers: { ...headers, Authorization: `Bearer ${key}` } };
		case "anthropic-messages":
			return { url: `${base}/v1/models`, headers: { ...headers, "x-api-key": key, "anthropic-version": "2023-06-01" } };
		case "google-generative-ai":
			return { url: `${base}/models?key=${encodeURIComponent(key)}`, headers };
		default:
			return null;
	}
}

export interface KeyTestDeps {
	fetch: typeof fetch;
	keyValue(id: string): string | undefined;
	modelsFor(providerId: string): readonly ProbeModel[];
	now(): number;
}

function defaultDeps(): KeyTestDeps {
	return {
		fetch: (...args) => fetch(...args),
		keyValue,
		modelsFor: (providerId) => piModels().getModels(providerId),
		now: () => performance.now(),
	};
}

function modelCount(body: unknown): number | undefined {
	if (!body || typeof body !== "object") return undefined;
	const { data, models } = body as { data?: unknown; models?: unknown };
	if (Array.isArray(data)) return data.length;
	if (Array.isArray(models)) return models.length;
	return undefined;
}

export async function testProviderKey(id: string, overrides: Partial<KeyTestDeps> = {}): Promise<KeyTestResult> {
	const deps: KeyTestDeps = { ...defaultDeps(), ...overrides };
	const providers = AUTH_PROVIDER_KEYS.filter((p) => p.envVar === id);
	if (providers.length === 0) return { status: "unsupported" };
	const key = deps.keyValue(id);
	if (!key) return { status: "no_key" };

	let request: ProbeRequest | null = null;
	for (const provider of providers) {
		for (const model of deps.modelsFor(provider.id)) {
			request = probeRequestFor(model, key);
			if (request) break;
		}
		if (request) break;
	}
	if (!request) return { status: "unsupported" };

	const start = deps.now();
	let res: Response;
	try {
		res = await deps.fetch(request.url, { headers: request.headers, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	} catch {
		return { status: "unreachable" };
	}
	const latencyMs = Math.round(deps.now() - start);
	if (res.status >= 200 && res.status < 300) {
		let models: number | undefined;
		try {
			models = modelCount(await res.json());
		} catch {
			models = undefined;
		}
		return models === undefined ? { status: "ok", latencyMs } : { status: "ok", latencyMs, models };
	}
	if (res.status === 401 || res.status === 403) return { status: "invalid", latencyMs, httpStatus: res.status };
	return { status: "http_error", latencyMs, httpStatus: res.status };
}
