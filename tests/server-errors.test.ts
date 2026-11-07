import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en, fa } from "../lib/i18n/messages/index.ts";
import { localizeServerError } from "../lib/i18n/server-errors.ts";

describe("localizeServerError", () => {
	it("maps an exact server message", () => {
		assert.equal(localizeServerError("Endpoint timed out", fa), fa.errors.customEndpoint.timeout);
		assert.equal(localizeServerError("Endpoint timed out", en), "Endpoint timed out");
	});

	it("maps a regex row with its capture group", () => {
		const out = localizeServerError("Endpoint returned HTTP 502", fa);
		assert.ok(out.includes("502"));
		assert.notEqual(out, "Endpoint returned HTTP 502");
	});

	it("returns unknown text unchanged", () => {
		const raw = "Something unexpected { happened }";
		assert.equal(localizeServerError(raw, fa), raw);
	});
});
