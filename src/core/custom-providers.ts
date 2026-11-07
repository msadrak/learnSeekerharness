/**
 * CUSTOM (MANUAL) PROVIDERS — the pure schema + validator (custom-providers
 * wave). PURE, browser-safe: no fs, no env, no pi-ai runtime.
 *
 * A custom provider is a user-declared model endpoint — Ollama, LM Studio,
 * vLLM, LiteLLM, a corporate gateway, any OpenAI/Anthropic/Gemini-compatible
 * proxy — described by a protocol, a base URL, an optional credential, and a
 * hand-entered model list. The record is a non-secret JSON file at the data
 * seam (config.CUSTOM_PROVIDERS_FILE); the credential (API key or bearer
 * token) is a SECRET and rides in the credentials store instead, never in
 * this record.
 *
 * Validation is the write-side gate (bad shapes are 400s, never stored) and
 * also the read-side sanitizer: a hand-edited file with one bad provider
 * loses THAT provider only (the store drops invalid entries, keeps the rest).
 */

/** The wire protocols a custom endpoint may speak — a subset of pi-ai's
 *  chat APIs that make sense for a hand-declared URL. */
export const CUSTOM_API_PROTOCOLS = [
	{ id: "openai-completions", label: "OpenAI Chat Completions", hint: "Most compatible servers: Ollama, LM Studio, vLLM, LiteLLM, llama.cpp", exampleBaseUrl: "http://localhost:11434/v1" },
	{ id: "openai-responses", label: "OpenAI Responses", hint: "Servers implementing /v1/responses", exampleBaseUrl: "https://api.openai.com/v1" },
	{ id: "anthropic-messages", label: "Anthropic Messages", hint: "Anthropic or an Anthropic-compatible gateway", exampleBaseUrl: "https://api.anthropic.com" },
	{ id: "google-generative-ai", label: "Google Generative AI", hint: "Gemini API or a Gemini-compatible gateway", exampleBaseUrl: "https://generativelanguage.googleapis.com/v1beta" },
] as const;

export type CustomApiProtocol = (typeof CUSTOM_API_PROTOCOLS)[number]["id"];

/** How the credential is presented. `default` = the protocol's native
 *  scheme (Bearer for OpenAI, x-api-key for Anthropic, key param for
 *  Gemini); `bearer` forces `Authorization: Bearer <token>` — gateways that
 *  front a non-OpenAI protocol with a bearer token. */
export const CUSTOM_AUTH_SCHEMES = ["default", "bearer"] as const;
export type CustomAuthScheme = (typeof CUSTOM_AUTH_SCHEMES)[number];

export type CustomModelInput = "text" | "image";

/** One hand-entered model. Only `id` is required; the rest default
 *  conservatively (see CUSTOM_MODEL_DEFAULTS). */
export interface CustomModelDef {
	id: string;
	/** Display name; defaults to the id. */
	name?: string;
	reasoning?: boolean;
	input?: CustomModelInput[];
	contextWindow?: number;
	maxTokens?: number;
}

export interface CustomProviderDef {
	/** Stable slug: the provider id used in model pins (`provider:id`). */
	id: string;
	/** Display name for the picker and settings. */
	name: string;
	api: CustomApiProtocol;
	baseUrl: string;
	authScheme: CustomAuthScheme;
	models: CustomModelDef[];
}

/** The persisted file shape. `version` is a private schema counter. */
export interface CustomProvidersFile {
	version: 1;
	providers: CustomProviderDef[];
}

export const CUSTOM_MODEL_DEFAULTS = {
	contextWindow: 128_000,
	maxTokens: 16_384,
} as const;

export const CUSTOM_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_MODELS = 200;
const MAX_NAME = 80;
const MAX_MODEL_ID = 200;

export type CustomValidation<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Slugify a display name into a candidate id (UI convenience; the id
 *  still goes through validateCustomProvider). */
export function slugifyProviderId(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return /^[a-z]/.test(slug) ? slug : slug ? `p-${slug}`.slice(0, 40) : "";
}

function validBaseUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.username || url.password) return null; // credentials never ride in the URL
	if (url.search || url.hash) return null;
	return url.toString().replace(/\/+$/, "");
}

function positiveInt(v: unknown, label: string): CustomValidation<number | undefined> {
	if (v === undefined || v === null) return { ok: true, value: undefined };
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 100_000_000) {
		return { ok: false, error: `${label} must be a positive integer` };
	}
	return { ok: true, value: v };
}

function validateModel(raw: unknown, index: number): CustomValidation<CustomModelDef> {
	const at = `models[${index}]`;
	if (!isRecord(raw)) return { ok: false, error: `${at} must be an object` };
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id || id.length > MAX_MODEL_ID || /[\s\u0000-\u001f]/.test(id)) {
		return { ok: false, error: `${at}.id is required (no whitespace, max ${MAX_MODEL_ID} chars)` };
	}
	const out: CustomModelDef = { id };
	if (raw.name !== undefined) {
		if (typeof raw.name !== "string" || raw.name.length > MAX_NAME) return { ok: false, error: `${at}.name must be a string up to ${MAX_NAME} chars` };
		if (raw.name.trim()) out.name = raw.name.trim();
	}
	if (raw.reasoning !== undefined) {
		if (typeof raw.reasoning !== "boolean") return { ok: false, error: `${at}.reasoning must be a boolean` };
		out.reasoning = raw.reasoning;
	}
	if (raw.input !== undefined) {
		if (!Array.isArray(raw.input) || raw.input.length === 0 || raw.input.some((m) => m !== "text" && m !== "image")) {
			return { ok: false, error: `${at}.input must be a non-empty list of "text" | "image"` };
		}
		const modalities = [...new Set(raw.input as CustomModelInput[])];
		if (!modalities.includes("text")) modalities.unshift("text");
		out.input = modalities;
	}
	const ctx = positiveInt(raw.contextWindow, `${at}.contextWindow`);
	if (!ctx.ok) return ctx;
	if (ctx.value !== undefined) out.contextWindow = ctx.value;
	const max = positiveInt(raw.maxTokens, `${at}.maxTokens`);
	if (!max.ok) return max;
	if (max.value !== undefined) out.maxTokens = max.value;
	if (out.contextWindow !== undefined && out.maxTokens !== undefined && out.maxTokens > out.contextWindow) {
		return { ok: false, error: `${at}.maxTokens cannot exceed contextWindow` };
	}
	return { ok: true, value: out };
}

/**
 * Validate one provider definition. `reservedIds` are ids the definition may
 * not take (every built-in pi-ai provider, the app's pseudo-providers) —
 * a custom provider must never shadow a real one, because model pins are
 * keyed by provider id.
 */
export function validateCustomProvider(raw: unknown, reservedIds: ReadonlySet<string> = new Set()): CustomValidation<CustomProviderDef> {
	if (!isRecord(raw)) return { ok: false, error: "provider must be an object" };
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!CUSTOM_ID_PATTERN.test(id)) {
		return { ok: false, error: "id must be a lowercase slug: letters, digits, hyphens; starts with a letter; max 40 chars" };
	}
	if (reservedIds.has(id)) return { ok: false, error: `id "${id}" is reserved by a built-in provider — pick another` };
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (!name || name.length > MAX_NAME) return { ok: false, error: `name is required (max ${MAX_NAME} chars)` };
	const protocol = CUSTOM_API_PROTOCOLS.find((p) => p.id === raw.api);
	if (!protocol) return { ok: false, error: `api must be one of: ${CUSTOM_API_PROTOCOLS.map((p) => p.id).join(", ")}` };
	if (typeof raw.baseUrl !== "string") return { ok: false, error: "baseUrl is required" };
	const baseUrl = validBaseUrl(raw.baseUrl.trim());
	if (!baseUrl) return { ok: false, error: "baseUrl must be an http(s) URL without credentials, query, or fragment" };
	const authScheme = raw.authScheme === undefined ? "default" : raw.authScheme;
	if (authScheme !== "default" && authScheme !== "bearer") return { ok: false, error: `authScheme must be one of: ${CUSTOM_AUTH_SCHEMES.join(", ")}` };
	if (!Array.isArray(raw.models) || raw.models.length === 0) return { ok: false, error: "at least one model is required" };
	if (raw.models.length > MAX_MODELS) return { ok: false, error: `at most ${MAX_MODELS} models per provider` };
	const models: CustomModelDef[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.models.length; i++) {
		const m = validateModel(raw.models[i], i);
		if (!m.ok) return m;
		if (seen.has(m.value.id)) return { ok: false, error: `duplicate model id "${m.value.id}"` };
		seen.add(m.value.id);
		models.push(m.value);
	}
	return { ok: true, value: { id, name, api: protocol.id, baseUrl, authScheme, models } };
}

/** Parse the persisted file leniently: a bad entry is dropped, the rest
 *  survive (hand-edit safety); a non-object / wrong version = empty. */
export function parseCustomProvidersFile(raw: unknown, reservedIds: ReadonlySet<string> = new Set()): CustomProviderDef[] {
	if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.providers)) return [];
	const out: CustomProviderDef[] = [];
	const seen = new Set<string>();
	for (const entry of raw.providers) {
		const v = validateCustomProvider(entry, reservedIds);
		if (!v.ok || seen.has(v.value.id)) continue;
		seen.add(v.value.id);
		out.push(v.value);
	}
	return out;
}
