import assert from "node:assert/strict";
import { test } from "node:test";
import { isRawProviderError } from "../components/chat";

test("isRawProviderError flags JSON payloads", () => {
	assert.equal(isRawProviderError('{"error":{"message":"x"}}'), true);
});

test("isRawProviderError flags long plain text", () => {
	assert.equal(isRawProviderError("x".repeat(201)), true);
});

test("isRawProviderError passes short sentences", () => {
	assert.equal(isRawProviderError("Rate limited"), false);
});
