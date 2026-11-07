/**
 * The custom-provider validator (custom-providers wave): the write-side gate
 * for hand-declared endpoints and the lenient file parser. Pins the rules
 * that protect the app: a custom id may never shadow a real provider
 * (model pins are keyed by provider id), a base URL may never smuggle
 * credentials, and one bad entry in a hand-edited file loses only itself.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCustomProvidersFile, slugifyProviderId, validateCustomProvider } from "../src/core/custom-providers.ts";

const good = {
	id: "local-ollama",
	name: "Local Ollama",
	api: "openai-completions",
	baseUrl: "http://localhost:11434/v1/",
	models: [{ id: "llama3.1:8b" }],
};

describe("validateCustomProvider", () => {
	it("accepts a minimal definition and normalizes it", () => {
		const v = validateCustomProvider(good);
		assert.ok(v.ok);
		if (!v.ok) return;
		assert.equal(v.value.baseUrl, "http://localhost:11434/v1", "trailing slash trimmed so joined paths stay clean");
		assert.equal(v.value.authScheme, "default");
		assert.deepEqual(v.value.models, [{ id: "llama3.1:8b" }]);
	});

	it("refuses ids reserved by built-in providers", () => {
		const v = validateCustomProvider({ ...good, id: "anthropic" }, new Set(["anthropic"]));
		assert.equal(v.ok, false);
	});

	it("refuses non-slug ids", () => {
		for (const id of ["", "Has Space", "1starts-digit", "UPPER", "a".repeat(41)]) {
			assert.equal(validateCustomProvider({ ...good, id }).ok, false, id);
		}
	});

	it("refuses base URLs that are not plain http(s) or carry credentials/query", () => {
		for (const baseUrl of ["ftp://x.test", "not a url", "http://user:pw@x.test/v1", "http://x.test/v1?key=1", "http://x.test/v1#frag", ""]) {
			assert.equal(validateCustomProvider({ ...good, baseUrl }).ok, false, baseUrl);
		}
	});

	it("refuses unknown protocols and empty/duplicate model lists", () => {
		assert.equal(validateCustomProvider({ ...good, api: "soap" }).ok, false);
		assert.equal(validateCustomProvider({ ...good, models: [] }).ok, false);
		assert.equal(validateCustomProvider({ ...good, models: [{ id: "a" }, { id: "a" }] }).ok, false);
	});

	it("refuses maxTokens above the context window and non-integer limits", () => {
		assert.equal(validateCustomProvider({ ...good, models: [{ id: "a", contextWindow: 1000, maxTokens: 2000 }] }).ok, false);
		assert.equal(validateCustomProvider({ ...good, models: [{ id: "a", contextWindow: 1.5 }] }).ok, false);
	});

	it("always includes text modality when images are declared", () => {
		const v = validateCustomProvider({ ...good, models: [{ id: "a", input: ["image"] }] });
		assert.ok(v.ok);
		if (v.ok) assert.deepEqual(v.value.models[0]?.input, ["text", "image"]);
	});
});

describe("parseCustomProvidersFile", () => {
	it("drops invalid and duplicate entries but keeps the rest", () => {
		const parsed = parseCustomProvidersFile({
			version: 1,
			providers: [good, { ...good, id: "BAD ID" }, good, { ...good, id: "second" }],
		});
		assert.deepEqual(parsed.map((p) => p.id), ["local-ollama", "second"]);
	});

	it("treats a wrong version or shape as empty", () => {
		assert.deepEqual(parseCustomProvidersFile({ version: 2, providers: [good] }), []);
		assert.deepEqual(parseCustomProvidersFile(null), []);
		assert.deepEqual(parseCustomProvidersFile([good]), []);
	});
});

describe("slugifyProviderId", () => {
	it("produces a valid id or nothing", () => {
		assert.equal(slugifyProviderId("My LM Studio!"), "my-lm-studio");
		assert.equal(slugifyProviderId("123 gateway"), "p-123-gateway");
		assert.equal(slugifyProviderId("!!!"), "");
	});
});
