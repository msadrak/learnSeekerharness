/**
 * Passage matching (src/core/document-locate.ts) — the one matcher behind the
 * agent tools, the annotation writers and the viewer's highlights.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { locateAll, normalizeForMatch } from "../src/core/document-locate.ts";

describe("locateAll — what counts as the same passage", () => {
	it("ignores whitespace, line breaks, punctuation and case", () => {
		const hits = locateAll(["The  conservation\nof ENERGY, holds."], "the conservation of energy holds");
		assert.equal(hits.length, 1);
		assert.deepEqual(hits[0]!.start, { segment: 0, offset: 0 });
		assert.equal(hits[0]!.end.offset, "The  conservation\nof ENERGY, holds".length);
	});

	it("treats Arabic and Persian letter variants and diacritics as equal", () => {
		assert.equal(locateAll(["كتاب علي"], "کتاب علی").length, 1);
		assert.equal(locateAll(["Un café très chaud"], "cafe tres chaud").length, 1);
	});

	it("matches rendered text against Markdown source (emphasis, links, tags, footnote refs)", () => {
		const source = ["Energy is **conserved** in a [closed system](https://example.com/a \"t\")", "<mark>always</mark>[^lh-1] holds."];
		assert.equal(locateAll(source, "conserved in a closed system always holds").length, 1);
	});

	it("reports exact segment points across segments", () => {
		const segments = ["Hel", "lo wor", "ld and more"];
		const [hit] = locateAll(segments, "Hello world");
		assert.deepEqual(hit!.start, { segment: 0, offset: 0 });
		assert.deepEqual(hit!.end, { segment: 2, offset: 2 });
		// a match that begins mid-segment
		const [mid] = locateAll(segments, "world and");
		assert.deepEqual(mid!.start, { segment: 1, offset: 3 });
		assert.deepEqual(mid!.end, { segment: 2, offset: 6 });
	});

	it("finds every non-overlapping occurrence, in order", () => {
		const hits = locateAll(["aa bb aa bb aa"], "aa bb");
		assert.equal(hits.length, 2);
		assert.equal(hits[0]!.start.offset, 0);
		assert.equal(hits[1]!.start.offset, 6);
	});

	it("returns nothing for an absent or empty quote", () => {
		assert.deepEqual(locateAll(["alpha beta"], "gamma"), []);
		assert.deepEqual(locateAll(["alpha beta"], " ,.; "), []);
	});

	it("normalizeForMatch maps each kept character to its original index", () => {
		const { chars, map } = normalizeForMatch("a-B  c");
		assert.equal(chars, "abc");
		assert.deepEqual(map, [0, 2, 5]);
	});
});
