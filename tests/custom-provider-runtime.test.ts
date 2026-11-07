/**
 * Custom providers end to end through the server composition and pi-ai
 * (custom-providers wave): a hand-declared endpoint must (1) appear in
 * piModels() and the picker catalog, (2) authenticate with the stored key —
 * keyless servers with a placeholder — without the key ever touching
 * providers.json, (3) really send requests to ITS base URL, (4) hot-reload
 * a hand-edit of the file, and (5) never shadow a built-in provider.
 * All dirs are throwaway; the data/credential seams are env-bound BEFORE the imports.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-providers-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_CREDENTIALS_FILE = path.join(TMP, "credentials.json");
const PROVIDERS_FILE = path.join(TMP, "data", "providers.json");

const { customProviderViews, removeCustomProvider, saveCustomProvider } = await import("../src/server/providers.ts");
const { piModels } = await import("../src/agent/models.ts");
const { catalogProviders, modelCatalog } = await import("../src/server/model-catalog.ts");
const { credentialStore } = await import("../src/store/credentials.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const def = (over: Record<string, unknown> = {}) => ({
	id: "my-llm",
	name: "My LLM",
	api: "openai-completions",
	baseUrl: "http://llm.test:8080/v1",
	models: [{ id: "m1", name: "Model One", contextWindow: 32000 }],
	...over,
});

function sseResponse(text: string): Response {
	const chunk = (delta: object, finish: string | null, usage?: object) =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
	const body = chunk({ role: "assistant", content: text }, null) + chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) + "data: [DONE]\n\n";
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("custom providers", () => {
	it("registers the provider and its models in pi-ai and the picker catalog", async () => {
		const saved = await saveCustomProvider(def());
		assert.ok(saved.ok);
		const model = piModels().getModel("my-llm", "m1");
		assert.ok(model, "model resolvable by provider:id");
		assert.equal(model.api, "openai-completions");
		assert.equal(model.baseUrl, "http://llm.test:8080/v1");
		assert.equal(model.contextWindow, 32000);
		assert.equal(model.name, "Model One");
		// Keyless is a normal state: the provider is connected by existing.
		assert.equal(catalogProviders().find((p) => p.id === "my-llm")?.keyPresent, true);
		assert.ok(modelCatalog().models.some((m) => m.provider === "my-llm" && m.id === "m1"));
	});

	it("authenticates keyless with a placeholder and with the stored key afterwards — which never lands in providers.json", async () => {
		const model = piModels().getModel("my-llm", "m1")!;
		assert.equal((await piModels().getAuth(model))?.auth.apiKey, "not-needed");

		const saved = await saveCustomProvider(def(), "sk-test-secret-123");
		assert.ok(saved.ok && saved.provider.hasKey);
		assert.equal((await piModels().getAuth(model))?.auth.apiKey, "sk-test-secret-123");
		assert.ok(!fs.readFileSync(PROVIDERS_FILE, "utf-8").includes("sk-test-secret-123"), "secret must stay out of the non-secret record");
		assert.ok(!JSON.stringify(customProviderViews()).includes("sk-test-secret-123"), "views never carry the key");

		// undefined key leaves it; null clears it
		await saveCustomProvider(def({ name: "My LLM 2" }));
		assert.equal(credentialStore.typeOf("my-llm"), "api_key");
		await saveCustomProvider(def(), null);
		assert.equal(credentialStore.typeOf("my-llm"), undefined);
	});

	it("sends the key as a bearer header when authScheme is bearer (non-OpenAI protocol)", async () => {
		await saveCustomProvider(def({ id: "gw", api: "anthropic-messages", authScheme: "bearer", baseUrl: "http://gw.test" }), "tok-abcdef");
		const model = piModels().getModel("gw", "m1")!;
		const auth = await piModels().getAuth(model);
		assert.equal(auth?.auth.headers?.Authorization, "Bearer tok-abcdef");
		assert.equal(auth?.auth.apiKey, undefined);
	});

	it("really calls the declared base URL with the stored key", async () => {
		await saveCustomProvider(def(), "sk-wire-key-999");
		const seen: { url: string; auth: string | null }[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = new Request(input, init);
			seen.push({ url: req.url, auth: req.headers.get("authorization") });
			return sseResponse("hello there");
		}) as typeof fetch;
		try {
			const model = piModels().getModel("my-llm", "m1")!;
			const result = await piModels().completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.ok(result.content.some((c) => c.type === "text" && c.text.includes("hello there")));
		} finally {
			globalThis.fetch = realFetch;
		}
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.url, "http://llm.test:8080/v1/chat/completions");
		assert.equal(seen[0]?.auth, "Bearer sk-wire-key-999");
	});

	it("hot-reloads a hand-edit of providers.json", async () => {
		const file = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf-8"));
		file.providers.push(def({ id: "hand-edited", name: "Hand Edited", models: [{ id: "x1" }] }));
		file.providers = file.providers.filter((p: { id: string }) => p.id !== "gw");
		fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(file));
		assert.ok(piModels().getModel("hand-edited", "x1"), "added by hand");
		assert.equal(piModels().getModel("gw", "m1"), undefined, "removed by hand");
	});

	it("refuses ids that would shadow a built-in provider", async () => {
		for (const id of ["anthropic", "openai", "chatgpt", "google-gemini-cli", "google-antigravity"]) {
			const r = await saveCustomProvider(def({ id }));
			assert.equal(r.ok, false, id);
		}
	});

	it("rejects an invalid body without touching the record or the key", async () => {
		const before = fs.readFileSync(PROVIDERS_FILE, "utf-8");
		assert.equal((await saveCustomProvider(def({ baseUrl: "javascript:alert(1)" }), "sk-should-not-save-1")).ok, false);
		assert.equal((await saveCustomProvider(def(), "has whitespace in key")).ok, false);
		assert.equal(fs.readFileSync(PROVIDERS_FILE, "utf-8"), before);
	});

	it("removing a provider drops its models and its stored key", async () => {
		assert.equal(await removeCustomProvider("my-llm"), true);
		assert.equal(piModels().getModel("my-llm", "m1"), undefined);
		assert.equal(credentialStore.typeOf("my-llm"), undefined);
		assert.equal(catalogProviders().some((p) => p.id === "my-llm"), false);
		assert.equal(await removeCustomProvider("my-llm"), false, "idempotent");
	});
});
