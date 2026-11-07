import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Importing the server module loads the key store; isolate it from the
// developer's data and credentials. All network calls are injected.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-keytest-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");

const { probeRequestFor, testProviderKey } = await import("../src/server/key-test.ts");
import type { ProbeModel } from "../src/server/key-test.ts";

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const model = (over: Partial<ProbeModel>): ProbeModel => ({ api: "openai-completions", baseUrl: "https://api.example.com/v1", provider: "example", ...over });

describe("probeRequestFor", () => {
	it("openai-completions strips trailing slashes and uses Bearer", () => {
		const r = probeRequestFor(model({ baseUrl: "https://api.example.com/v1///" }), "sk-secret");
		assert.deepEqual(r, { url: "https://api.example.com/v1/models", headers: { Authorization: "Bearer sk-secret" } });
	});

	it("openai-responses probes /models with Bearer", () => {
		const r = probeRequestFor(model({ api: "openai-responses" }), "k");
		assert.equal(r?.url, "https://api.example.com/v1/models");
		assert.equal(r?.headers.Authorization, "Bearer k");
	});

	it("anthropic-messages uses x-api-key and the version header", () => {
		const r = probeRequestFor(model({ api: "anthropic-messages", baseUrl: "https://api.anthropic.com/", provider: "anthropic" }), "ak");
		assert.deepEqual(r, {
			url: "https://api.anthropic.com/v1/models",
			headers: { "x-api-key": "ak", "anthropic-version": "2023-06-01" },
		});
	});

	it("google-generative-ai carries the key as an encoded query parameter", () => {
		const r = probeRequestFor(model({ api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", provider: "google" }), "a b&c");
		assert.equal(r?.url, "https://generativelanguage.googleapis.com/v1beta/models?key=a%20b%26c");
		assert.deepEqual(r?.headers, {});
	});

	it("mistral-conversations probes /v1/models", () => {
		const r = probeRequestFor(model({ api: "mistral-conversations", baseUrl: "https://api.mistral.ai", provider: "mistral" }), "mk");
		assert.deepEqual(r, { url: "https://api.mistral.ai/v1/models", headers: { Authorization: "Bearer mk" } });
	});

	it("openrouter overrides the URL (its /models is public)", () => {
		const r = probeRequestFor(model({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }), "ork");
		assert.deepEqual(r, { url: "https://openrouter.ai/api/v1/key", headers: { Authorization: "Bearer ork" } });
	});

	it("returns null for an unsupported api", () => {
		assert.equal(probeRequestFor(model({ api: "bedrock-converse-stream" }), "k"), null);
	});

	it("merges model headers and lets auth headers win", () => {
		const r = probeRequestFor(model({ headers: { "X-Custom": "1", Authorization: "Bearer provider-default" } }), "real");
		assert.deepEqual(r?.headers, { "X-Custom": "1", Authorization: "Bearer real" });
	});
});

describe("testProviderKey", () => {
	const ID = "OPENAI_API_KEY";
	const models = () => [model({ provider: "openai" })];
	const clock = () => {
		let t = 0;
		return () => (t += 25);
	};
	const respond = (res: () => Response | Promise<Response>) => ({
		fetch: (async () => res()) as typeof fetch,
		keyValue: () => "sk-test-key-123456",
		modelsFor: models,
		now: clock(),
	});

	it("200 with data array → ok, counts models, reports latency", async () => {
		const r = await testProviderKey(ID, respond(() => Response.json({ data: [1, 2, 3] })));
		assert.equal(r.status, "ok");
		assert.equal(r.models, 3);
		assert.equal(r.latencyMs, 25);
	});

	it("200 with models array falls back to its length; unparsable body leaves models unset", async () => {
		const a = await testProviderKey(ID, respond(() => Response.json({ models: [1, 2] })));
		assert.equal(a.models, 2);
		const b = await testProviderKey(ID, respond(() => new Response("not json", { status: 200 })));
		assert.equal(b.status, "ok");
		assert.equal(b.models, undefined);
	});

	it("401 and 403 → invalid", async () => {
		assert.equal((await testProviderKey(ID, respond(() => new Response("", { status: 401 })))).status, "invalid");
		assert.equal((await testProviderKey(ID, respond(() => new Response("", { status: 403 })))).status, "invalid");
	});

	it("500 → http_error with the status", async () => {
		const r = await testProviderKey(ID, respond(() => new Response("", { status: 500 })));
		assert.equal(r.status, "http_error");
		assert.equal(r.httpStatus, 500);
	});

	it("fetch throwing → unreachable", async () => {
		const r = await testProviderKey(ID, respond(() => { throw new Error("ECONNREFUSED"); }));
		assert.deepEqual(r, { status: "unreachable" });
	});

	it("empty key → no_key without any request", async () => {
		let called = false;
		const r = await testProviderKey(ID, {
			fetch: (async () => { called = true; return new Response(""); }) as typeof fetch,
			keyValue: () => undefined,
			modelsFor: models,
		});
		assert.deepEqual(r, { status: "no_key" });
		assert.equal(called, false);
	});

	it("unknown id → unsupported", async () => {
		const r = await testProviderKey("NOT_A_PROVIDER_KEY", respond(() => Response.json({})));
		assert.deepEqual(r, { status: "unsupported" });
	});

	it("no probeable model → unsupported", async () => {
		const r = await testProviderKey(ID, { ...respond(() => Response.json({})), modelsFor: () => [model({ api: "bedrock-converse-stream" })] });
		assert.deepEqual(r, { status: "unsupported" });
	});

	it("never leaks the key in the result", async () => {
		const r = await testProviderKey(ID, respond(() => new Response("", { status: 401 })));
		assert.ok(!JSON.stringify(r).includes("sk-test-key"));
	});

	it("sends the request with manual redirects and the probe headers", async () => {
		let seen: { url: string; init?: RequestInit } | undefined;
		await testProviderKey(ID, {
			fetch: (async (url: string, init?: RequestInit) => { seen = { url, init }; return Response.json({}); }) as unknown as typeof fetch,
			keyValue: () => "kk",
			modelsFor: models,
		});
		assert.equal(seen?.url, "https://api.example.com/v1/models");
		assert.equal(seen?.init?.redirect, "manual");
		assert.deepEqual(seen?.init?.headers, { Authorization: "Bearer kk" });
	});
});
