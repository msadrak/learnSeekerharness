/**
 * The file-backed credential store (subscriptions wave): pi-ai's contract is
 * that `modify` is a serialized read-modify-write — concurrent writers (an
 * OAuth refresh racing a login, a custom key save racing a logout) must never
 * lose each other's updates, because the whole file is rewritten per write.
 * LH_CREDENTIALS_FILE is set BEFORE the dynamic import (the path is module-load bound).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-credentials-"));
const FILE = path.join(TMP, "credentials.json");
process.env.LH_CREDENTIALS_FILE = FILE;
const { credentialStore } = await import("../src/store/credentials.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const oauth = (access: string) => ({ type: "oauth" as const, access, refresh: `r-${access}`, expires: 123 });

describe("credentialStore", () => {
	it("starts empty when the file is absent", async () => {
		assert.equal(await credentialStore.read("anthropic"), undefined);
		assert.deepEqual(credentialStore.listSync(), []);
		assert.equal(credentialStore.typeOf("anthropic"), undefined);
	});

	it("does not lose updates across concurrent modifies of different providers", async () => {
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				credentialStore.modify(`p${i}`, async () => {
					// yield so interleaving would expose a missing queue
					await new Promise((r) => setTimeout(r, 1));
					return oauth(`a${i}`);
				}),
			),
		);
		assert.equal(credentialStore.listSync().length, 12);
	});

	it("passes the current credential to modify, and undefined leaves it unchanged", async () => {
		await credentialStore.modify("anthropic", async () => oauth("old"));
		const after = await credentialStore.modify("anthropic", async (current) => (current?.type === "oauth" ? oauth(`${current.access}-new`) : undefined));
		assert.equal(after?.type === "oauth" && after.access, "old-new");
		const unchanged = await credentialStore.modify("anthropic", async () => undefined);
		assert.equal(unchanged?.type === "oauth" && unchanged.access, "old-new");
	});

	it("persists api_key and oauth credentials distinguishably, and deletes", async () => {
		await credentialStore.modify("custom-x", async () => ({ type: "api_key", key: "k" }));
		assert.equal(credentialStore.typeOf("custom-x"), "api_key");
		assert.equal(credentialStore.typeOf("anthropic"), "oauth");
		await credentialStore.delete("custom-x");
		assert.equal(credentialStore.typeOf("custom-x"), undefined);
		await credentialStore.delete("custom-x"); // idempotent
	});

	it("ignores malformed entries and a corrupt file instead of throwing", async () => {
		fs.writeFileSync(FILE, JSON.stringify({ version: 1, credentials: { good: oauth("g"), bad: { type: "oauth", access: 5 }, weird: 7 } }));
		assert.deepEqual(credentialStore.listSync().map((c) => c.providerId), ["good"]);
		fs.writeFileSync(FILE, "{ not json");
		assert.deepEqual(credentialStore.listSync(), []);
	});

	it("writes the file owner-only", { skip: process.platform === "win32" }, async () => {
		await credentialStore.modify("m", async () => oauth("m"));
		assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
	});
});
