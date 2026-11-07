/**
 * Google Cloud Code Assist providers (Gemini CLI + Antigravity): request body
 * mapping, SSE → assistant events, retry/error handling, and the OAuth
 * credential lifecycle. No real network: globalThis.fetch is stubbed per test.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
	getSupportedThinkingLevels,
	normalizeContext,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Message,
	type Model,
	type OAuthCredential,
	type Provider,
	type ProviderAuthInteraction,
	type Tool,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { antigravityProvider, geminiCliProvider } from "../src/agent/google-cloudcode/index.ts";
import { discoverAntigravityProject, discoverGeminiCliProject, parseAuthorizationInput } from "../src/agent/google-cloudcode/oauth.ts";

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}
let calls: Call[] = [];
let handler: (call: Call) => Response | Promise<Response> = () => new Response("unexpected request", { status: 500 });
const realFetch = globalThis.fetch;

beforeEach(() => {
	calls = [];
	handler = () => new Response("unexpected request", { status: 500 });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: Object.fromEntries(new Headers(init?.headers)),
			body: init?.body === undefined ? "" : String(init.body),
		};
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const sseBody = (chunks: unknown[], eol = "\n") => chunks.map((c) => `data: ${JSON.stringify(c)}${eol}${eol}`).join("");
const sse = (chunks: unknown[]) => new Response(sseBody(chunks), { headers: { "content-type": "text/event-stream" } });
/** An SSE response delivered in awkward pieces (splits inside JSON, CRLF line ends, no trailing newline). */
function sseSplit(chunks: unknown[], pieceSize: number): Response {
	const text = sseBody(chunks, "\r\n").trimEnd();
	const bytes = new TextEncoder().encode(text);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += pieceSize) controller.enqueue(bytes.slice(i, i + pieceSize));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
const chunk = (parts: unknown[], extra: Record<string, unknown> = {}, response: Record<string, unknown> = {}) => ({
	response: { candidates: [{ content: { role: "model", parts }, ...extra }], ...response },
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const gemini = geminiCliProvider();
const antigravity = antigravityProvider();
function modelOf(provider: Provider, id: string): Model<string> {
	const model = provider.getModels().find((m) => m.id === id);
	assert(model, `model ${id} missing from ${provider.id}`);
	return model;
}
const credential = (extra: Record<string, unknown> = {}): OAuthCredential => ({
	type: "oauth",
	refresh: "refresh-1",
	access: "access-1",
	expires: Date.now() + 3_600_000,
	projectId: "proj-1",
	...extra,
});
async function apiKeyFor(provider: Provider): Promise<string> {
	const auth = await provider.auth.oauth!.toAuth(credential());
	assert(auth.apiKey);
	return auth.apiKey;
}

const readFile: Tool = { name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function transcript(model: Model<string>) {
	const messages: Message[] = [
		{ role: "user", content: "Open notes.txt", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Looking." },
				{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "notes.txt" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: 2,
		},
		{ role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: [{ type: "text", text: "hello" }], isError: false, timestamp: 3 },
	];
	return normalizeContext({ systemPrompt: "Be brief.", messages, tools: [readFile] });
}

async function run(stream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

const finishStop = () => chunk([{ text: "ok" }], { finishReason: "STOP" });
const sentBody = (index = 0) => JSON.parse(calls[index]!.body);

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

test("providers expose OAuth-only subscription auth and the ported model catalogs", () => {
	for (const [provider, id, name] of [
		[gemini, "google-gemini-cli", "Google Gemini CLI (Code Assist)"],
		[antigravity, "google-antigravity", "Google Antigravity"],
	] as const) {
		assert.equal(provider.id, id);
		assert.equal(provider.name, name);
		assert.equal(provider.auth.apiKey, undefined);
		assert.equal(provider.auth.oauth?.isSubscription, true);
		assert(provider.getModels().length > 0);
		for (const model of provider.getModels()) {
			assert.equal(model.provider, id);
			assert.equal(model.api, "google-gemini-cli");
			assert(model.baseUrl.startsWith("https://"));
		}
	}
	assert.deepEqual(gemini.getModels().map((m) => m.id), ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3-pro-preview"]);
	assert.equal(modelOf(antigravity, "claude-sonnet-4-5").baseUrl, "https://daily-cloudcode-pa.sandbox.googleapis.com");
	assert.deepEqual(modelOf(antigravity, "gpt-oss-120b-medium").input, ["text"]);
	// Gemini 3 cannot switch thinking off.
	assert.deepEqual(getSupportedThinkingLevels(modelOf(gemini, "gemini-3-pro-preview")), ["minimal", "low", "medium", "high"]);
	assert(getSupportedThinkingLevels(modelOf(gemini, "gemini-2.5-flash")).includes("off"));
});

// ---------------------------------------------------------------------------
// request mapping
// ---------------------------------------------------------------------------

test("gemini cli request: endpoint, auth, system prompt, tool-call round trip, tools", async () => {
	handler = () => sse([finishStop()]);
	const model = modelOf(gemini, "gemini-3-pro-preview");
	await run(gemini.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(gemini), temperature: 0.3, maxTokens: 1234 }));

	assert.equal(calls.length, 1);
	const call = calls[0]!;
	assert.equal(call.url, "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
	assert.equal(call.method, "POST");
	assert.equal(call.headers.authorization, "Bearer access-1");
	assert.equal(call.headers.accept, "text/event-stream");
	assert.equal(call.headers["content-type"], "application/json");
	assert.equal(call.headers["anthropic-beta"], undefined);

	const body = sentBody();
	assert.equal(body.project, "proj-1");
	assert.equal(body.model, "gemini-3-pro-preview");
	assert.equal(body.requestType, undefined);
	assert.equal(body.userAgent, "pi-coding-agent");
	assert.match(body.requestId, /^pi-\d+-[a-z0-9]+$/);
	assert.deepEqual(body.request.systemInstruction, { parts: [{ text: "Be brief." }] });
	assert.deepEqual(body.request.generationConfig, { temperature: 0.3, maxOutputTokens: 1234 });
	assert.deepEqual(body.request.contents, [
		{ role: "user", parts: [{ text: "Open notes.txt" }] },
		{ role: "model", parts: [{ text: "Looking." }, { functionCall: { name: "read_file", args: { path: "notes.txt" }, id: "call_1" } }] },
		{ role: "user", parts: [{ functionResponse: { name: "read_file", response: { output: "hello" }, id: "call_1" } }] },
	]);
	assert.deepEqual(body.request.tools, [
		{
			functionDeclarations: [
				{
					name: "read_file",
					description: "Read a file",
					parametersJsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			],
		},
	]);
	assert.equal(body.request.toolConfig, undefined);
});

test("toolChoice, onPayload and header overrides reach the wire", async () => {
	handler = () => sse([finishStop()]);
	const model = modelOf(gemini, "gemini-2.5-pro");
	await run(
		gemini.streamSimple(model, transcript(model), {
			apiKey: await apiKeyFor(gemini),
			toolChoice: "none",
			headers: { "X-Extra": "1", "client-metadata": null },
			onPayload: (payload) => ({ ...(payload as object), requestId: "patched" }),
		}),
	);
	const body = sentBody();
	assert.deepEqual(body.request.toolConfig, { functionCallingConfig: { mode: "NONE" } });
	assert.equal(body.requestId, "patched");
	assert.equal(calls[0]!.headers["x-extra"], "1");
	assert.equal(calls[0]!.headers["client-metadata"], undefined);
});

test("thinking config follows the model family and reasoning level", async () => {
	const cases: [Provider, string, "minimal" | "low" | "medium" | "high" | undefined, Record<string, unknown> | undefined][] = [
		[gemini, "gemini-3-pro-preview", "minimal", { includeThoughts: true, thinkingLevel: "LOW" }],
		[gemini, "gemini-3-pro-preview", "medium", { includeThoughts: true, thinkingLevel: "HIGH" }],
		[gemini, "gemini-3-flash-preview", "medium", { includeThoughts: true, thinkingLevel: "MEDIUM" }],
		[antigravity, "gemini-3-pro-low", "low", { includeThoughts: true, thinkingLevel: "LOW" }],
		[gemini, "gemini-2.5-flash", "medium", { includeThoughts: true, thinkingBudget: 8192 }],
		[antigravity, "claude-sonnet-4-5-thinking", "high", { includeThoughts: true, thinkingBudget: 16384 }],
		[gemini, "gemini-2.5-flash", undefined, undefined],
		[gemini, "gemini-2.0-flash", "high", undefined], // not a reasoning model
		[antigravity, "claude-sonnet-4-5", "high", undefined],
	];
	handler = () => sse([finishStop()]);
	for (const [provider, id, reasoning, expected] of cases) {
		calls = [];
		const model = modelOf(provider, id);
		await run(provider.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(provider), reasoning }));
		assert.deepEqual(sentBody().request.generationConfig.thinkingConfig, expected, `${id} @ ${reasoning}`);
	}
});

test("antigravity request: daily endpoint, agent envelope, system preamble, claude tool schema + beta header", async () => {
	handler = () => sse([finishStop()]);
	const model = modelOf(antigravity, "claude-sonnet-4-5-thinking");
	await run(antigravity.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(antigravity) }));

	const call = calls[0]!;
	assert.equal(call.url, "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse");
	assert.match(call.headers["user-agent"]!, /^antigravity\/[\d.]+ /);
	assert.equal(call.headers["anthropic-beta"], "interleaved-thinking-2025-05-14");

	const body = sentBody();
	assert.equal(body.requestType, "agent");
	assert.equal(body.userAgent, "antigravity");
	assert.match(body.requestId, /^agent-\d+-/);
	const instruction = body.request.systemInstruction;
	assert.equal(instruction.role, "user");
	assert.equal(instruction.parts.length, 3);
	assert.match(instruction.parts[0].text, /^You are Antigravity/);
	assert.match(instruction.parts[1].text, /^Please ignore following \[ignore\]You are Antigravity.*\[\/ignore\]$/);
	assert.deepEqual(instruction.parts[2], { text: "Be brief." });
	// Claude behind Cloud Code Assist wants the OpenAPI `parameters` field, not parametersJsonSchema.
	const declaration = body.request.tools[0].functionDeclarations[0];
	assert.deepEqual(declaration.parameters, { type: "object", properties: { path: { type: "string" } }, required: ["path"] });
	assert.equal(declaration.parametersJsonSchema, undefined);
	// Non-gemini models keep the call id on the wire.
	assert.equal(body.request.contents[1].parts[1].functionCall.id, "call_1");
});

// ---------------------------------------------------------------------------
// response parsing
// ---------------------------------------------------------------------------

test("SSE chunks (split mid-JSON, CRLF, no trailing newline) become ordered assistant events with usage + cost", async () => {
	const chunks = [
		chunk([{ text: "Plan: ", thought: true }], {}, { responseId: "resp-1" }),
		chunk([{ text: "check files", thought: true, thoughtSignature: "c2ln" }]),
		chunk([{ text: "Reading " }]),
		chunk([{ text: "now." }, { functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: "dGhvdWdodA==" }]),
		chunk([{ functionCall: { name: "read_file", id: "dup", args: { path: "b" } } }]),
		chunk([{ functionCall: { name: "read_file", id: "dup", args: { path: "c" } } }]),
		{
			response: {
				candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
				usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 50, thoughtsTokenCount: 20, totalTokenCount: 1070 },
			},
		},
		{ ignored: "chunk without a response envelope" },
	];
	handler = () => sseSplit(chunks, 37);
	const model = modelOf(antigravity, "gemini-3-pro-high");
	const { events, message } = await run(antigravity.stream(model, transcript(model), { apiKey: await apiKeyFor(antigravity) }));

	assert.deepEqual(
		events.map((e) => e.type),
		[
			"start",
			"thinking_start", "thinking_delta", "thinking_delta", "thinking_end",
			"text_start", "text_delta", "text_delta", "text_end",
			"toolcall_start", "toolcall_delta", "toolcall_end",
			"toolcall_start", "toolcall_delta", "toolcall_end",
			"toolcall_start", "toolcall_delta", "toolcall_end",
			"done",
		],
	);
	const thinkingEnd = events.find((e) => e.type === "thinking_end");
	assert.equal(thinkingEnd?.type === "thinking_end" && thinkingEnd.content, "Plan: check files");

	assert.equal(message.stopReason, "toolUse");
	assert.equal(message.responseId, "resp-1");
	assert.equal(message.api, "google-gemini-cli");
	assert.equal(message.provider, "google-antigravity");
	assert.equal(message.model, "gemini-3-pro-high");
	const [thinking, text, call1, call2, call3] = message.content;
	assert.deepEqual(thinking, { type: "thinking", thinking: "Plan: check files", thinkingSignature: "c2ln" });
	assert.equal(text?.type === "text" && text.text, "Reading now.");
	assert(call1?.type === "toolCall" && call2?.type === "toolCall" && call3?.type === "toolCall");
	assert.match(call1.id, /^read_file_\d+_\d+$/);
	assert.deepEqual(call1.arguments, { path: "a.txt" });
	assert.equal(call1.thoughtSignature, "dGhvdWdodA==");
	assert.equal(call2.id, "dup");
	assert.notEqual(call3.id, "dup", "duplicate provider ids must be regenerated so tool results stay unambiguous");
	assert.deepEqual(call3.arguments, { path: "c" });

	// promptTokenCount includes the cached part; thoughts are billed as output.
	const { cost, ...counts } = message.usage;
	assert.deepEqual(counts, { input: 600, output: 70, cacheRead: 400, cacheWrite: 0, reasoning: 20, totalTokens: 1070 });
	assert(Math.abs(cost.input - 0.0012) < 1e-12);
	assert(Math.abs(cost.output - 0.00084) < 1e-12);
	assert(Math.abs(cost.cacheRead - 0.00008) < 1e-12);
	assert(Math.abs(cost.total - 0.00212) < 1e-12);
});

test("finish reasons: MAX_TOKENS is length, SAFETY is an error carrying the raw reason", async () => {
	const model = modelOf(gemini, "gemini-2.5-flash");
	const apiKey = await apiKeyFor(gemini);

	handler = () => sse([chunk([{ text: "cut" }], { finishReason: "MAX_TOKENS" })]);
	const length = await run(gemini.streamSimple(model, transcript(model), { apiKey }));
	assert.equal(length.message.stopReason, "length");
	assert.equal(length.events.at(-1)?.type, "done");

	handler = () => sse([chunk([{ text: "x" }], { finishReason: "SAFETY" })]);
	const blocked = await run(gemini.streamSimple(model, transcript(model), { apiKey }));
	assert.equal(blocked.message.stopReason, "error");
	assert.equal(blocked.message.errorMessage, "Provider stopped with: SAFETY");
	assert.equal(blocked.events.at(-1)?.type, "error");
});

test("a streamed tool call without a finish reason still ends as toolUse", async () => {
	handler = () => sse([chunk([{ functionCall: { name: "read_file", id: "c1", args: { path: "x" } } }])]);
	const model = modelOf(gemini, "gemini-2.5-flash");
	const { message } = await run(gemini.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(gemini) }));
	assert.equal(message.stopReason, "toolUse");
});

// ---------------------------------------------------------------------------
// errors, retries, abort
// ---------------------------------------------------------------------------

test("auth problems: missing key throws from streamSimple, malformed key is a stream error without a request", async () => {
	const model = modelOf(gemini, "gemini-2.5-flash");
	assert.throws(() => gemini.streamSimple(model, transcript(model), {}), /No API key for provider: google-gemini-cli/);

	const bad = await run(gemini.stream(model, transcript(model), { apiKey: "not json" }));
	assert.equal(bad.message.stopReason, "error");
	assert.match(bad.message.errorMessage!, /Invalid Google Cloud Code Assist credentials/);
	const noProject = await run(gemini.stream(model, transcript(model), { apiKey: JSON.stringify({ token: "t" }) }));
	assert.match(noProject.message.errorMessage!, /Missing token or projectId/);
	assert.equal(calls.length, 0);
});

test("a non-retryable HTTP error is surfaced once, with Google's message", async () => {
	handler = () => json({ error: { code: 400, message: "Request contains an invalid argument." } }, 400);
	const model = modelOf(gemini, "gemini-2.5-flash");
	const { events, message } = await run(gemini.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(gemini) }));
	assert.equal(calls.length, 1, "400s must not be retried");
	assert.equal(message.stopReason, "error");
	assert.equal(message.errorMessage, "Cloud Code Assist API error (400): Request contains an invalid argument.");
	assert.deepEqual(events.map((e) => e.type), ["error"]);
});

test("a long server-requested retry delay fails fast instead of sleeping", async () => {
	handler = () => json({ error: { message: "Quota exceeded. Your quota will reset after 34s." } }, 429);
	const model = modelOf(gemini, "gemini-2.5-flash");
	const { message } = await run(gemini.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(gemini), maxRetryDelayMs: 5000 }));
	assert.equal(calls.length, 1);
	assert.match(message.errorMessage!, /^Server requested 35s retry delay \(max: 5s\)\. Quota exceeded/);
});

/** Run `work` with `setTimeout` mocked, advancing the clock whenever the stream is parked in a retry sleep. */
async function withFakeTimers<T>(work: () => Promise<T>): Promise<T> {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		let done = false;
		const pending = work().finally(() => {
			done = true;
		});
		while (!done) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			mock.timers.tick(60_000);
		}
		return await pending;
	} finally {
		mock.timers.reset();
	}
}

test("a transient 503 is retried and the retry's stream is what the caller sees", async () => {
	let attempt = 0;
	handler = () => (++attempt === 1 ? new Response("backend unavailable", { status: 503 }) : sse([chunk([{ text: "recovered" }], { finishReason: "STOP" })]));
	const model = modelOf(gemini, "gemini-2.5-flash");
	const { message } = await withFakeTimers(async () => run(gemini.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(gemini) })));
	assert.equal(calls.length, 2);
	assert.equal(calls[0]!.body, calls[1]!.body, "the retry resends the identical request");
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(message.content, [{ type: "text", text: "recovered", textSignature: undefined }]);
});

test("an empty stream is retried once before content arrives, without a duplicate start", async () => {
	let attempt = 0;
	handler = () => (++attempt === 1 ? sse([{ response: { candidates: [{ finishReason: "STOP" }] } }]) : sse([chunk([{ text: "second try" }], { finishReason: "STOP" })]));
	const model = modelOf(gemini, "gemini-2.5-flash");
	const { events, message } = await withFakeTimers(async () => run(gemini.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(gemini) })));
	assert.equal(calls.length, 2);
	assert.equal(events.filter((e) => e.type === "start").length, 1);
	assert.equal(message.content[0]?.type === "text" && message.content[0].text, "second try");
});

test("aborting mid-stream ends with an aborted error event", async () => {
	const encoder = new TextEncoder();
	handler = () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(sseBody([chunk([{ text: "partial" }])]))); // then never closes
				},
			}),
		);
	const controller = new AbortController();
	const model = modelOf(gemini, "gemini-2.5-flash");
	const stream = gemini.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(gemini), signal: controller.signal });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "text_delta") controller.abort();
	}
	const last = events.at(-1);
	assert(last?.type === "error");
	assert.equal(last.reason, "aborted");
	assert.equal(last.error.stopReason, "aborted");
	assert.equal(last.error.content[0]?.type === "text" && last.error.content[0].text, "partial");
});

test("a pre-aborted signal sends nothing", async () => {
	const model = modelOf(gemini, "gemini-2.5-flash");
	const { message } = await run(gemini.streamSimple(model, transcript(model), { apiKey: await apiKeyFor(gemini), signal: AbortSignal.abort() }));
	assert.equal(message.stopReason, "aborted");
	assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// OAuth: credential shape, refresh, login
// ---------------------------------------------------------------------------

test("toAuth hands the stream a JSON apiKey with token and project", async () => {
	const auth = await gemini.auth.oauth!.toAuth(credential());
	assert.deepEqual(auth, { apiKey: JSON.stringify({ token: "access-1", projectId: "proj-1" }) });
	await assert.rejects(gemini.auth.oauth!.toAuth({ type: "oauth", refresh: "r", access: "a", expires: 1 }), /missing projectId/);
});

test("refresh posts the right client, keeps the refresh token / project / email, and shortens expiry", async () => {
	const clients: [Provider, string][] = [
		[gemini, "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"],
		[antigravity, "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"],
	];
	const secrets = new Set<string>();
	for (const [provider, clientId] of clients) {
		calls = [];
		handler = () => json({ access_token: "access-2", expires_in: 3600, token_type: "Bearer" });
		const before = Date.now();
		const refreshed = await provider.auth.oauth!.refresh(credential({ email: "me@example.com" }), new AbortController().signal);

		const call = calls[0]!;
		assert.equal(call.url, "https://oauth2.googleapis.com/token");
		assert.equal(call.method, "POST");
		assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
		const form = new URLSearchParams(call.body);
		assert.equal(form.get("client_id"), clientId);
		assert.match(form.get("client_secret")!, /^GOCSPX-/);
		secrets.add(form.get("client_secret")!);
		assert.equal(form.get("grant_type"), "refresh_token");
		assert.equal(form.get("refresh_token"), "refresh-1");

		assert.deepEqual({ ...refreshed, expires: undefined }, {
			type: "oauth",
			refresh: "refresh-1", // Google omitted a new one
			access: "access-2",
			expires: undefined,
			projectId: "proj-1",
			email: "me@example.com",
		});
		// one hour minus the 5 minute safety buffer
		assert(refreshed.expires >= before + 3_300_000 && refreshed.expires <= Date.now() + 3_300_000);
	}
	assert.equal(secrets.size, 2, "the two providers use different OAuth clients");
});

test("refresh adopts a rotated refresh token and rejects on Google errors or a project-less credential", async () => {
	handler = () => json({ access_token: "a2", refresh_token: "rotated", expires_in: 60 });
	const rotated = await antigravity.auth.oauth!.refresh(credential(), new AbortController().signal);
	assert.equal(rotated.refresh, "rotated");

	handler = () => json({ error: "invalid_grant" }, 400);
	await assert.rejects(gemini.auth.oauth!.refresh(credential(), new AbortController().signal), /Google Gemini CLI \(Code Assist\) token refresh failed: .*invalid_grant/);

	calls = [];
	await assert.rejects(gemini.auth.oauth!.refresh({ type: "oauth", refresh: "r", access: "a", expires: 1 }, new AbortController().signal), /missing projectId/);
	assert.equal(calls.length, 0);
});

/** Interaction double: records events; `prompt` is answered by `answer(authUrl)` or stays pending until aborted. */
function interactionDouble(answer?: (authUrl: URL) => string | Promise<string>) {
	const controller = new AbortController();
	const events: Parameters<ProviderAuthInteraction["notify"]>[0][] = [];
	const prompts: Parameters<ProviderAuthInteraction["prompt"]>[0][] = [];
	let promptAsked: () => void = () => {};
	/** Resolves once login is parked on the callback/paste race (server already listening, URL announced). */
	const asked = new Promise<void>((resolve) => {
		promptAsked = resolve;
	});
	const authUrl = () => {
		const event = events.find((e) => e.type === "auth_url");
		assert(event?.type === "auth_url", "login must announce the authorization URL");
		return new URL(event.url);
	};
	const interaction: ProviderAuthInteraction = {
		signal: controller.signal,
		notify: (event) => void events.push(event),
		prompt: (prompt) => {
			prompts.push(prompt);
			promptAsked();
			if (answer) return Promise.resolve().then(() => answer(authUrl()));
			return new Promise<string>((_, reject) => prompt.signal?.addEventListener("abort", () => reject(new Error("prompt cancelled"))));
		},
	};
	return { interaction, events, prompts, asked, authUrl, controller };
}

function stubGoogleApis(project = "proj-123") {
	handler = (call) => {
		if (call.url === "https://oauth2.googleapis.com/token") return json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });
		if (call.url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) return json({ email: "dev@example.com" });
		if (call.url.endsWith("/v1internal:loadCodeAssist")) return json({ currentTier: { id: "standard-tier" }, cloudaicompanionProject: project });
		return new Response("unexpected " + call.url, { status: 500 });
	};
}

const tokenExchange = () => new URLSearchParams(calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!.body);

test("login: manual paste forms (redirect URL, query string, bare code) complete the flow and PKCE is wired", async () => {
	for (const [paste, code] of [
		[(url: URL) => `http://localhost:8085/oauth2callback?code=PASTED&state=${url.searchParams.get("state")}`, "PASTED"],
		[(url: URL) => `code=QUERY&state=${url.searchParams.get("state")}`, "QUERY"],
		[() => "  BARECODE  ", "BARECODE"],
	] as const) {
		calls = [];
		stubGoogleApis();
		const { interaction, events, prompts, authUrl } = interactionDouble(paste);
		const result = await gemini.auth.oauth!.login(interaction);

		assert.deepEqual({ ...result, expires: undefined }, {
			type: "oauth",
			refresh: "ref",
			access: "acc",
			expires: undefined,
			projectId: "proj-123",
			email: "dev@example.com",
		});
		assert(result.expires > Date.now() + 3_000_000 && result.expires <= Date.now() + 3_300_000);
		assert.equal(prompts[0]?.type, "manual_code");

		const url = authUrl();
		assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
		assert.equal(url.searchParams.get("client_id"), "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com");
		assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8085/oauth2callback");
		assert.equal(url.searchParams.get("response_type"), "code");
		assert.equal(url.searchParams.get("access_type"), "offline");
		assert.equal(url.searchParams.get("code_challenge_method"), "S256");
		assert(url.searchParams.get("scope")!.includes("https://www.googleapis.com/auth/cloud-platform"));
		assert(events.every((e) => e.type === "progress" || e.type === "auth_url"));

		const form = tokenExchange();
		assert.equal(form.get("grant_type"), "authorization_code");
		assert.equal(form.get("code"), code);
		assert.equal(form.get("redirect_uri"), "http://localhost:8085/oauth2callback");
		const verifier = form.get("code_verifier")!;
		assert.equal(createHash("sha256").update(verifier).digest("base64url"), url.searchParams.get("code_challenge"));
		assert.notEqual(url.searchParams.get("state"), verifier, "the PKCE verifier must never double as the OAuth state");
	}
});

test("login rejects a pasted redirect with a foreign state, a provider error, or nothing", async () => {
	stubGoogleApis();
	for (const [paste, message] of [
		["http://localhost:8085/oauth2callback?code=X&state=attacker", /state mismatch/],
		["http://localhost:8085/oauth2callback?error=access_denied", /access_denied/],
		["   ", /No authorization code/],
	] as const) {
		const { interaction } = interactionDouble(() => paste);
		await assert.rejects(gemini.auth.oauth!.login(interaction), message);
	}
	assert(!calls.some((c) => c.url === "https://oauth2.googleapis.com/token"), "no token exchange without a valid code");
});

test("login fails when Google returns no refresh token", async () => {
	handler = () => json({ access_token: "acc", expires_in: 3600 });
	const { interaction } = interactionDouble(() => "CODE");
	await assert.rejects(gemini.auth.oauth!.login(interaction), /No refresh token received/);
});

async function portIsFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createNetServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
	});
}
function httpGet(port: number, path: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", agent: false }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end();
	});
}

test("login: the 127.0.0.1 callback wins over the pending paste prompt, bad-state callbacks are ignored, and the server closes", async (t) => {
	if (!(await portIsFree(8085))) return t.skip("port 8085 is busy on this machine");
	stubGoogleApis();
	const { interaction, authUrl, asked } = interactionDouble();
	const login = gemini.auth.oauth!.login(interaction);

	// wait for the auth URL announcement, then hit the callback like the browser would
	await asked;
	const state = authUrl().searchParams.get("state")!;
	assert.equal(await httpGet(8085, "/oauth2callback?code=EVIL&state=wrong"), 400);
	assert.equal(await httpGet(8085, "/elsewhere"), 404);
	assert.equal(await httpGet(8085, `/oauth2callback?code=BROWSERCODE&state=${state}`), 200);

	const result = await login;
	assert.equal(result.access, "acc");
	assert.equal(tokenExchange().get("code"), "BROWSERCODE");
	assert.equal(await portIsFree(8085), true, "callback server must be closed after login");
});

test("login abort closes the callback server and rejects", async (t) => {
	if (!(await portIsFree(8085))) return t.skip("port 8085 is busy on this machine");
	const { interaction, controller, asked } = interactionDouble();
	const login = gemini.auth.oauth!.login(interaction);
	const settled = assert.rejects(login, /cancel/i);
	await asked;
	controller.abort();
	await settled;
	assert.equal(await portIsFree(8085), true);
});

test("antigravity login uses its own redirect, scopes and callback port", async () => {
	stubGoogleApis();
	const { interaction, authUrl } = interactionDouble(() => "CODE");
	handler = (call) => {
		if (call.url === "https://oauth2.googleapis.com/token") return json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });
		if (call.url.startsWith("https://www.googleapis.com/")) return json({ email: "x@example.com" });
		return json({ cloudaicompanionProject: { id: "ag-project" } });
	};
	const result = await antigravity.auth.oauth!.login(interaction);
	assert.equal(result.projectId, "ag-project");
	const url = authUrl();
	assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:51121/oauth-callback");
	assert.equal(url.searchParams.get("client_id"), "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
	assert(url.searchParams.get("scope")!.includes("https://www.googleapis.com/auth/cclog"));
	assert(url.searchParams.get("scope")!.includes("https://www.googleapis.com/auth/experimentsandconfigs"));
});

// ---------------------------------------------------------------------------
// project discovery
// ---------------------------------------------------------------------------

test("antigravity discovery: object or string project, endpoint fallback, shared default", async () => {
	handler = (call) => (call.url.startsWith("https://cloudcode-pa.googleapis.com") ? json({ cloudaicompanionProject: { id: "prod-proj" } }) : json({}, 500));
	assert.equal(await discoverAntigravityProject("tok", () => {}), "prod-proj");

	// prod fails, the sandbox answers with a string project
	calls = [];
	handler = (call) => (call.url.startsWith("https://daily-cloudcode-pa") ? json({ cloudaicompanionProject: "daily-proj" }) : json({}, 503));
	assert.equal(await discoverAntigravityProject("tok", () => {}), "daily-proj");
	assert.deepEqual(calls.map((c) => new URL(c.url).host), ["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.sandbox.googleapis.com"]);
	assert.equal(calls[0]!.headers.authorization, "Bearer tok");

	handler = () => json({}, 500);
	assert.equal(await discoverAntigravityProject("tok", () => {}), "rising-fact-p41fc");
});

test("gemini discovery: existing project, free-tier onboarding, and the env-var requirement for paid tiers", async () => {
	const saved = { a: process.env.GOOGLE_CLOUD_PROJECT, b: process.env.GOOGLE_CLOUD_PROJECT_ID };
	delete process.env.GOOGLE_CLOUD_PROJECT;
	delete process.env.GOOGLE_CLOUD_PROJECT_ID;
	try {
		handler = () => json({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "existing" });
		assert.equal(await discoverGeminiCliProject("tok", () => {}), "existing");

		calls = [];
		handler = (call) =>
			call.url.endsWith(":loadCodeAssist")
				? json({ allowedTiers: [{ id: "legacy-tier" }, { id: "free-tier", isDefault: true }] })
				: json({ done: true, response: { cloudaicompanionProject: { id: "provisioned" } } });
		assert.equal(await discoverGeminiCliProject("tok", () => {}), "provisioned");
		const onboard = JSON.parse(calls[1]!.body);
		assert.equal(calls[1]!.url, "https://cloudcode-pa.googleapis.com/v1internal:onboardUser");
		assert.equal(onboard.tierId, "free-tier");
		assert.equal(onboard.cloudaicompanionProject, undefined, "free tier lets Google provision the project");

		// Non-free default tier: needs the user's own project.
		handler = () => json({ allowedTiers: [{ id: "standard-tier", isDefault: true }] });
		await assert.rejects(discoverGeminiCliProject("tok", () => {}), /GOOGLE_CLOUD_PROJECT/);
		process.env.GOOGLE_CLOUD_PROJECT = "my-project";
		calls = [];
		handler = (call) => (call.url.endsWith(":loadCodeAssist") ? json({ allowedTiers: [{ id: "standard-tier", isDefault: true }] }) : json({ done: true, response: {} }));
		assert.equal(await discoverGeminiCliProject("tok", () => {}), "my-project");
		assert.equal(JSON.parse(calls[1]!.body).cloudaicompanionProject, "my-project");

		// loadCodeAssist failure other than the VPC-SC policy is fatal
		handler = () => new Response("nope", { status: 403, statusText: "Forbidden" });
		await assert.rejects(discoverGeminiCliProject("tok", () => {}), /loadCodeAssist failed: 403 Forbidden: nope/);
	} finally {
		if (saved.a === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
		else process.env.GOOGLE_CLOUD_PROJECT = saved.a;
		if (saved.b === undefined) delete process.env.GOOGLE_CLOUD_PROJECT_ID;
		else process.env.GOOGLE_CLOUD_PROJECT_ID = saved.b;
	}
});

test("parseAuthorizationInput", () => {
	assert.equal(parseAuthorizationInput("http://localhost:8085/oauth2callback?code=a%2Fb&state=s", "s"), "a/b");
	assert.equal(parseAuthorizationInput("?code=q&state=s", "s"), "q");
	assert.equal(parseAuthorizationInput("4/0AbCd", "s"), "4/0AbCd");
	assert.throws(() => parseAuthorizationInput("http://localhost/x?state=s", "s"), /No authorization code/);
});
