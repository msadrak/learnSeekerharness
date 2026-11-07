/**
 * Cloud Code Assist streaming (`v1internal:streamGenerateContent?alt=sse`) for
 * Gemini CLI and Antigravity, ported from @mariozechner/pi-ai@0.55.0
 * `providers/google-gemini-cli.js` onto pi-ai 1.4's `ProviderStreams`.
 *
 * Message/tool conversion, thought-signature handling and stop-reason mapping
 * come from pi-ai's own `api/google-shared`. Auth arrives as `options.apiKey`
 * = JSON `{ token, projectId }` (see credentials.ts).
 *
 * Differences from the 0.55 code: HTTP errors are never retried as "network
 * errors" (0.55 swallowed its own thrown API errors into the retry loop),
 * `maxRetries` / `fetch` / `onPayload` / `onResponse` / `onProviderStreamEvent`
 * are honoured, `toolChoice` is passed through, and tool-call turns that end
 * without an explicit finish reason become `toolUse`.
 */
import {
	calculateCost,
	clampThinkingLevel,
	collapseSystemMessages,
	getCurrentTools,
	getInitialSystemMessage,
	getSystemMessageText,
	type Api,
	type AssistantMessage,
	type JsonObject,
	type Model,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type ToolChoice,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReasonString,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	toGoogleThinkingLevel,
	type GoogleApiThinkingLevel,
} from "@earendil-works/pi-ai/api/google-shared";
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { headersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import { decodeApiKey } from "./credentials.ts";
import { ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_PROVIDER_ID, CLOUDCODE_ENDPOINT } from "./models.ts";

const ANTIGRAVITY_ENDPOINT_FALLBACKS = [ANTIGRAVITY_DAILY_ENDPOINT, CLOUDCODE_ENDPOINT];

const CLIENT_METADATA = JSON.stringify({ ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" });
const GEMINI_CLI_HEADERS = {
	"User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
	"Client-Metadata": CLIENT_METADATA,
};
const DEFAULT_ANTIGRAVITY_VERSION = "1.15.8";
const antigravityHeaders = () => ({
	"User-Agent": `antigravity/${process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION} darwin/arm64`,
	"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"Client-Metadata": CLIENT_METADATA,
});

// Antigravity system instruction (compact version from CLIProxyAPI).
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";
const ABORTED = "Request was aborted";

let toolCallCounter = 0;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface CloudCodeStreamOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	thinking?: {
		enabled: boolean;
		/** Gemini 3: discrete level. */
		level?: GoogleApiThinkingLevel;
		/** Everything else: token budget. */
		budgetTokens?: number;
	};
}

interface GenerationConfig {
	temperature?: number;
	maxOutputTokens?: number;
	thinkingConfig?: { includeThoughts: boolean; thinkingLevel?: GoogleApiThinkingLevel; thinkingBudget?: number };
}

interface InnerRequest {
	contents: unknown[];
	sessionId?: string;
	systemInstruction?: { role?: "user"; parts: { text: string }[] };
	generationConfig?: GenerationConfig;
	tools?: unknown;
	toolConfig?: { functionCallingConfig: { mode: string } };
}

export interface CloudCodeRequest {
	project: string;
	model: string;
	request: InnerRequest;
	requestType?: "agent";
	userAgent: string;
	requestId: string;
}

/** `convertMessages` is typed for the two Google APIs but only reads `id`, `provider` and `input`. */
const asGoogleModel = (model: Model<Api>) => model as unknown as Model<"google-generative-ai">;

export function buildRequest(
	model: Model<Api>,
	context: TranscriptContext,
	projectId: string,
	options: CloudCodeStreamOptions = {},
	isAntigravity = false,
): CloudCodeRequest {
	const transcript = collapseSystemMessages(context);
	const contents = convertMessages(asGoogleModel(model), transcript);
	const systemMessage = getInitialSystemMessage(transcript.messages);
	const systemText = systemMessage ? getSystemMessageText(systemMessage) : "";
	const tools = getCurrentTools(transcript.messages);

	const generationConfig: GenerationConfig = {};
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
	// A disabled/absent thinking option sends no thinkingConfig at all (the 0.55 behaviour): the Code Assist
	// backend rejects some budget-0 configs, and Gemini 3 cannot disable thinking anyway.
	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: NonNullable<GenerationConfig["thinkingConfig"]> = { includeThoughts: true };
		if (options.thinking.level !== undefined) thinkingConfig.thinkingLevel = options.thinking.level;
		else if (options.thinking.budgetTokens !== undefined) thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		generationConfig.thinkingConfig = thinkingConfig;
	}

	const request: InnerRequest = { contents };
	if (options.sessionId) request.sessionId = options.sessionId;
	if (systemText) request.systemInstruction = { parts: [{ text: sanitizeSurrogates(systemText) }] };
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

	if (tools.length > 0) {
		// Claude models behind Cloud Code Assist need the legacy `parameters` field; the API translates it into `input_schema`.
		request.tools = convertTools(tools, model.id.startsWith("claude-"), false);
		const mode = resolveGoogleFunctionCallingMode(tools, options.toolChoice, false);
		if (mode !== undefined) request.toolConfig = { functionCallingConfig: { mode } };
	}

	if (isAntigravity) {
		request.systemInstruction = {
			role: "user",
			parts: [
				{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
				{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
				...(request.systemInstruction?.parts ?? []),
			],
		};
	}

	return {
		project: projectId,
		model: model.id,
		request,
		...(isAntigravity ? { requestType: "agent" as const } : {}),
		userAgent: isAntigravity ? "antigravity" : "pi-coding-agent",
		requestId: `${isAntigravity ? "agent" : "pi"}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

/**
 * Server-requested retry delay in ms (+1s safety margin), from headers
 * (Retry-After, x-ratelimit-reset, x-ratelimit-reset-after) or body text
 * ("reset after 18h31m10s", "Please retry in 34s|500ms", `"retryDelay": "34.07s"`).
 */
export function extractRetryDelay(errorText: string, response?: Response | Headers): number | undefined {
	const normalizeDelay = (ms: number): number | undefined => (ms > 0 ? Math.ceil(ms + 1000) : undefined);
	const headers = response instanceof Headers ? response : response?.headers;
	if (headers) {
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const seconds = Number(retryAfter);
			if (Number.isFinite(seconds)) {
				const delay = normalizeDelay(seconds * 1000);
				if (delay !== undefined) return delay;
			}
			const dateMs = new Date(retryAfter).getTime();
			if (!Number.isNaN(dateMs)) {
				const delay = normalizeDelay(dateMs - Date.now());
				if (delay !== undefined) return delay;
			}
		}
		const resetAt = headers.get("x-ratelimit-reset");
		if (resetAt) {
			const seconds = Number.parseInt(resetAt, 10);
			if (!Number.isNaN(seconds)) {
				const delay = normalizeDelay(seconds * 1000 - Date.now());
				if (delay !== undefined) return delay;
			}
		}
		const resetAfter = headers.get("x-ratelimit-reset-after");
		if (resetAfter) {
			const seconds = Number(resetAfter);
			if (Number.isFinite(seconds)) {
				const delay = normalizeDelay(seconds * 1000);
				if (delay !== undefined) return delay;
			}
		}
	}

	const duration = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (duration) {
		const hours = duration[1] ? parseInt(duration[1], 10) : 0;
		const minutes = duration[2] ? parseInt(duration[2], 10) : 0;
		const seconds = parseFloat(duration[3] ?? "");
		if (!Number.isNaN(seconds)) {
			const delay = normalizeDelay(((hours * 60 + minutes) * 60 + seconds) * 1000);
			if (delay !== undefined) return delay;
		}
	}

	for (const pattern of [/Please retry in ([0-9.]+)(ms|s)/i, /"retryDelay":\s*"([0-9.]+)(ms|s)"/i]) {
		const match = errorText.match(pattern);
		const value = parseFloat(match?.[1] ?? "");
		if (!Number.isNaN(value) && value > 0) {
			const delay = normalizeDelay(match?.[2]?.toLowerCase() === "ms" ? value : value * 1000);
			if (delay !== undefined) return delay;
		}
	}
	return undefined;
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(errorText);
}

/** The `error.message` of a Google error body, or the raw text. */
function extractErrorMessage(errorText: string): string {
	try {
		const parsed: { error?: { message?: string } } | null = JSON.parse(errorText);
		if (parsed?.error?.message) return parsed.error.message;
	} catch {
		// not JSON
	}
	return errorText;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error(ABORTED));
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error(ABORTED));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const isAbortError = (error: unknown): boolean => error instanceof Error && (error.name === "AbortError" || error.message === ABORTED);

/** Merge header layers; a `null` value removes the header (case-insensitive). */
function mergeHeaders(...layers: (Record<string, string | null> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const layer of layers) {
		for (const [name, value] of Object.entries(layer ?? {})) {
			for (const existing of Object.keys(merged)) if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
			if (value !== null) merged[name] = value;
		}
	}
	return merged;
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

interface UsageMetadata {
	promptTokenCount?: number;
	cachedContentTokenCount?: number;
	candidatesTokenCount?: number;
	thoughtsTokenCount?: number;
	totalTokenCount?: number;
}

interface CloudCodePart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: { id?: string; name?: string; args?: JsonObject };
}

interface CloudCodeChunk {
	response?: {
		responseId?: string;
		candidates?: { content?: { parts?: CloudCodePart[] }; finishReason?: string }[];
		usageMetadata?: UsageMetadata;
	};
}

export function streamCloudCode(model: Model<Api>, context: TranscriptContext, options?: CloudCodeStreamOptions): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
		const signal = options?.signal;
		const fetchFn = options?.fetch ?? globalThis.fetch;

		try {
			const { token, projectId } = decodeApiKey(options?.apiKey);
			const isAntigravity = model.provider === ANTIGRAVITY_PROVIDER_ID;
			const baseUrl = model.baseUrl?.trim();
			const endpoints = baseUrl ? [baseUrl] : isAntigravity ? ANTIGRAVITY_ENDPOINT_FALLBACKS : [CLOUDCODE_ENDPOINT];

			let payload: unknown = buildRequest(model, context, projectId, options, isAntigravity);
			const replaced = await options?.onPayload?.(payload, model);
			if (replaced !== undefined) payload = replaced;
			const body = JSON.stringify(payload);

			const headers = mergeHeaders(
				{
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					...(isAntigravity ? antigravityHeaders() : GEMINI_CLI_HEADERS),
					...(model.id.toLowerCase().includes("claude") && model.id.toLowerCase().includes("thinking")
						? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER }
						: {}),
				},
				model.headers,
				options?.headers,
			);

			const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
			const maxDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

			const post = async (url: string): Promise<Response> => {
				const response = await fetchFn(url, { method: "POST", headers, body, signal });
				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
				return response;
			};

			// Fetch with retries for rate limits, 5xx and network errors. Each retry may move to the next endpoint.
			let response: Response | undefined;
			let requestUrl = "";
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (signal?.aborted) throw new Error(ABORTED);
				requestUrl = `${endpoints[Math.min(attempt, endpoints.length - 1)]}/v1internal:streamGenerateContent?alt=sse`;

				let attemptResponse: Response;
				try {
					attemptResponse = await post(requestUrl);
				} catch (error) {
					if (signal?.aborted || isAbortError(error)) throw new Error(ABORTED);
					let failure = error instanceof Error ? error : new Error(String(error));
					if (failure.message === "fetch failed" && failure.cause instanceof Error) {
						failure = new Error(`Network error: ${failure.cause.message}`);
					}
					if (attempt === maxRetries) throw failure;
					await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
					continue;
				}
				if (attemptResponse.ok) {
					response = attemptResponse;
					break;
				}

				const errorText = await attemptResponse.text();
				if (attempt < maxRetries && isRetryableError(attemptResponse.status, errorText)) {
					const serverDelay = extractRetryDelay(errorText, attemptResponse);
					if (maxDelayMs > 0 && serverDelay && serverDelay > maxDelayMs) {
						throw new Error(
							`Server requested ${Math.ceil(serverDelay / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${extractErrorMessage(errorText)}`,
						);
					}
					await sleep(serverDelay ?? BASE_DELAY_MS * 2 ** attempt, signal);
					continue;
				}
				throw new Error(`Cloud Code Assist API error (${attemptResponse.status}): ${extractErrorMessage(errorText)}`);
			}
			if (!response) throw new Error("Failed to get response after retries");

			let started = false;
			const ensureStarted = (): void => {
				if (started) return;
				stream.push({ type: "start", partial: output });
				started = true;
			};

			/** Parse one SSE response into `output`/events. Returns whether any content arrived. */
			const consume = async (active: Response): Promise<boolean> => {
				if (!active.body) throw new Error("No response body");
				let hasContent = false;
				let current: TextContent | ThinkingContent | null = null;
				const blocks = output.content;
				const lastIndex = () => blocks.length - 1;

				const endCurrent = (): void => {
					if (!current) return;
					if (current.type === "text") stream.push({ type: "text_end", contentIndex: lastIndex(), content: current.text, partial: output });
					else stream.push({ type: "thinking_end", contentIndex: lastIndex(), content: current.thinking, partial: output });
					current = null;
				};

				const handlePart = (part: CloudCodePart): void => {
					if (part.text !== undefined) {
						hasContent = true;
						const thinking = isThinkingPart(part);
						if (!current || (thinking && current.type !== "thinking") || (!thinking && current.type !== "text")) {
							endCurrent();
							if (thinking) {
								current = { type: "thinking", thinking: "", thinkingSignature: undefined };
								blocks.push(current);
								ensureStarted();
								stream.push({ type: "thinking_start", contentIndex: lastIndex(), partial: output });
							} else {
								current = { type: "text", text: "" };
								blocks.push(current);
								ensureStarted();
								stream.push({ type: "text_start", contentIndex: lastIndex(), partial: output });
							}
						}
						if (current.type === "thinking") {
							current.thinking += part.text;
							current.thinkingSignature = retainThoughtSignature(current.thinkingSignature, part.thoughtSignature);
							stream.push({ type: "thinking_delta", contentIndex: lastIndex(), delta: part.text, partial: output });
						} else {
							current.text += part.text;
							current.textSignature = retainThoughtSignature(current.textSignature, part.thoughtSignature);
							stream.push({ type: "text_delta", contentIndex: lastIndex(), delta: part.text, partial: output });
						}
					}

					const call = part.functionCall;
					if (call) {
						hasContent = true;
						endCurrent();
						const needsNewId = !call.id || blocks.some((b) => b.type === "toolCall" && b.id === call.id);
						const toolCall: ToolCall = {
							type: "toolCall",
							id: needsNewId || !call.id ? `${call.name}_${Date.now()}_${++toolCallCounter}` : call.id,
							name: call.name || "",
							arguments: call.args ?? {},
							...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
						};
						blocks.push(toolCall);
						ensureStarted();
						stream.push({ type: "toolcall_start", contentIndex: lastIndex(), partial: output });
						stream.push({ type: "toolcall_delta", contentIndex: lastIndex(), delta: JSON.stringify(toolCall.arguments), partial: output });
						stream.push({ type: "toolcall_end", contentIndex: lastIndex(), toolCall, partial: output });
					}
				};

				const handleLine = async (rawLine: string): Promise<void> => {
					const line = rawLine.trimEnd();
					if (!line.startsWith("data:")) return;
					const json = line.slice(5).trim();
					if (!json) return;
					let chunk: CloudCodeChunk;
					try {
						chunk = JSON.parse(json);
					} catch {
						return;
					}
					await options?.onProviderStreamEvent?.(chunk, model);
					const data = chunk.response;
					if (!data) return;
					if (data.responseId) output.responseId ||= data.responseId;

					const candidate = data.candidates?.[0];
					for (const part of candidate?.content?.parts ?? []) handlePart(part);

					if (candidate?.finishReason) {
						output.rawStopReason = candidate.finishReason;
						output.stopReason = mapStopReasonString(candidate.finishReason);
						if (output.stopReason === "stop" && blocks.some((b) => b.type === "toolCall")) output.stopReason = "toolUse";
					}

					const meta = data.usageMetadata;
					if (meta) {
						// promptTokenCount includes cachedContentTokenCount; thoughts are billed as output.
						const cacheRead = meta.cachedContentTokenCount || 0;
						const thoughts = meta.thoughtsTokenCount || 0;
						output.usage = {
							input: (meta.promptTokenCount || 0) - cacheRead,
							output: (meta.candidatesTokenCount || 0) + thoughts,
							cacheRead,
							cacheWrite: 0,
							reasoning: thoughts,
							totalTokens: meta.totalTokenCount || 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
						calculateCost(model, output.usage);
					}
				};

				const reader = active.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				const onAbort = () => void reader.cancel().catch(() => {});
				signal?.addEventListener("abort", onAbort);
				try {
					while (true) {
						if (signal?.aborted) throw new Error(ABORTED);
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						for (const line of lines) await handleLine(line);
					}
					buffer += decoder.decode();
					if (buffer) await handleLine(buffer);
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
				endCurrent();
				return hasContent;
			};

			let receivedContent = false;
			let active = response;
			for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt++) {
				if (signal?.aborted) throw new Error(ABORTED);
				if (emptyAttempt > 0) {
					await sleep(EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1), signal);
					active = await post(requestUrl);
					if (!active.ok) {
						throw new Error(`Cloud Code Assist API error (${active.status}): ${extractErrorMessage(await active.text())}`);
					}
				}
				if (await consume(active)) {
					receivedContent = true;
					break;
				}
				if (emptyAttempt < MAX_EMPTY_STREAM_RETRIES) {
					// Nothing was emitted (no `start` either), so a clean reset is invisible to consumers.
					output.content = [];
					output.usage = emptyUsage();
					output.stopReason = "pending";
					output.rawStopReason = undefined;
					output.responseId = undefined;
				}
			}
			if (!receivedContent) throw new Error("Cloud Code Assist API returned an empty response");
			if (signal?.aborted) throw new Error(ABORTED);

			if (output.stopReason === "pending") {
				// Content arrived but no finish reason did; a dropped connection would have errored in read().
				output.stopReason = output.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.rawStopReason ? `Provider stopped with: ${output.rawStopReason}` : "An unknown error occurred");
			}
			stream.push({ type: "done", reason: output.stopReason as Extract<typeof output.stopReason, "stop" | "length" | "toolUse">, message: output });
			stream.end();
		} catch (error) {
			const reason = signal?.aborted ? "aborted" : "error";
			output.stopReason = reason;
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// ---------------------------------------------------------------------------
// Simple (reasoning-level) entry point
// ---------------------------------------------------------------------------

/** Gemini 3 Pro/Flash take a discrete thinking level; everything else takes a token budget. */
const usesThinkingLevel = (model: Model<Api>): boolean => model.id.includes("3-pro") || model.id.includes("3-flash");

export function streamSimpleCloudCode(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const base: CloudCodeStreamOptions = { ...buildBaseOptions(model, context, options, apiKey), toolChoice: options?.toolChoice };

	const level = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : "off";
	if (level === "off") return streamCloudCode(model, context, { ...base, thinking: { enabled: false } });

	if (usesThinkingLevel(model)) {
		const resolved = resolveGoogleThinkingLevel(asGoogleModel(model), level);
		return streamCloudCode(model, context, { ...base, thinking: { enabled: true, level: toGoogleThinkingLevel(resolved) } });
	}

	const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, level, options?.thinkingBudgets);
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
	return streamCloudCode(model, context, {
		...base,
		maxTokens,
		thinking: { enabled: true, budgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)) },
	});
}

export const cloudCodeStreams: ProviderStreams = {
	stream: (model, context, options) => streamCloudCode(model, context, options),
	streamSimple: (model, context, options) => streamSimpleCloudCode(model, context, options),
};
