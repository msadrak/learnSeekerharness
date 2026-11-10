/**
 * The saved model listings (data/model-listings): a listing round-trips as received, an unreadable
 * file reads as "nothing saved" and is replaced by the next write, and a provider id can never
 * steer the path outside the folder. Isolated LH_DATA_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-model-listings-"));
process.env.LH_DATA_DIR = TMP;

const { modelListingStore } = await import("../src/store/model-listings.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

const FOLDER = path.join(TMP, "model-listings");

describe("modelListingStore", () => {
	it("returns what was written, as received, and nothing for a provider that never saved", () => {
		assert.equal(modelListingStore.read("google-antigravity"), undefined);
		const listing = { models: { "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)" } }, agentModelSorts: [{ groups: [{ modelIds: ["gemini-4-argon-high"] }] }] };
		modelListingStore.write("google-antigravity", listing);
		assert.deepEqual(modelListingStore.read("google-antigravity"), listing);
		assert.equal(modelListingStore.read("google-gemini-cli"), undefined, "listings are per provider");
	});

	it("keeps only the newest listing and leaves no temp file behind", () => {
		modelListingStore.write("google-antigravity", { n: 1 });
		modelListingStore.write("google-antigravity", { n: 2 });
		assert.deepEqual(modelListingStore.read("google-antigravity"), { n: 2 });
		assert.deepEqual(fs.readdirSync(FOLDER), ["google-antigravity.json"]);
	});

	it("reads a corrupt or foreign-shaped file as nothing saved, and the next write replaces it", () => {
		const file = path.join(FOLDER, "google-antigravity.json");
		for (const bytes of ["{not json", "[]", '{"version":1}', ""]) {
			fs.writeFileSync(file, bytes);
			assert.equal(modelListingStore.read("google-antigravity"), undefined, JSON.stringify(bytes));
		}
		modelListingStore.write("google-antigravity", { ok: true });
		assert.deepEqual(modelListingStore.read("google-antigravity"), { ok: true });
	});

	it("refuses a provider id that is not a plain file name", () => {
		for (const id of ["../escape", "a/b", "a\\b", ".hidden", "", "x y"]) {
			assert.throws(() => modelListingStore.write(id, {}), /Invalid provider id/, JSON.stringify(id));
			assert.equal(modelListingStore.read(id), undefined, "reading never throws");
		}
		assert.ok(!fs.existsSync(path.join(TMP, "escape.json")));
	});
});
