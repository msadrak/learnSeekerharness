/**
 * Passage matching — the single implementation shared by the server tools,
 * the annotation writers and the browser viewer.
 *
 * A quote matches regardless of whitespace and line breaks, punctuation, case,
 * Arabic/Persian letter variants (ي→ی, ك→ک …) and diacritics. Markup that is
 * never part of the rendered text (HTML tags, Markdown footnote references and
 * link/image targets) is skipped.
 *
 * Text arrives as SEGMENTS: PDF text-item strings, DOM text nodes, docx `w:t`
 * texts, or Markdown source lines. Matches are reported as segment/offset
 * points so each caller can map them back to its own structure.
 */

/** Spans removed before matching: HTML tags, `[^footnote]` refs, `](link target "title")`. */
const SKIP_RE = /<\/?[A-Za-z][^<>]*>|\[\^[^\]\s]+\]|\]\([^)\s]*(?:\s+"[^"]*")?\)/g;

const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;
const MARK = /^\p{M}$/u;

const VARIANT: Record<string, string> = {
	"ي": "ی",
	"ى": "ی",
	"ك": "ک",
	"ة": "ه",
	"أ": "ا",
	"إ": "ا",
	"آ": "ا",
};

/** The normalized comparison text and, per UTF-16 unit of it, the UTF-16 index
 *  of the original code point that produced it. */
export function normalizeForMatch(text: string): { chars: string; map: number[] } {
	const skip: Array<[number, number]> = [];
	for (const m of text.matchAll(SKIP_RE)) skip.push([m.index!, m.index! + m[0].length]);
	let chars = "";
	const map: number[] = [];
	let skipIdx = 0;
	let i = 0;
	while (i < text.length) {
		while (skipIdx < skip.length && skip[skipIdx]![1] <= i) skipIdx++;
		if (skipIdx < skip.length && i >= skip[skipIdx]![0]) {
			i = skip[skipIdx]![1];
			continue;
		}
		const cp = String.fromCodePoint(text.codePointAt(i)!);
		for (const ch of cp.normalize("NFKD").toLowerCase()) {
			if (MARK.test(ch)) continue;
			const mapped = VARIANT[ch] ?? ch;
			if (!LETTER_OR_NUMBER.test(mapped)) continue;
			chars += mapped;
			for (let u = 0; u < mapped.length; u++) map.push(i);
		}
		i += cp.length;
	}
	return { chars, map };
}

export interface SegmentPoint {
	segment: number;
	/** UTF-16 offset within that segment. */
	offset: number;
}

export interface LocatedRange {
	start: SegmentPoint;
	/** Exclusive. */
	end: SegmentPoint;
}

/** Every non-overlapping match of `quote` across `segments`, in document order. */
export function locateAll(segments: readonly string[], quote: string): LocatedRange[] {
	const needle = normalizeForMatch(quote).chars;
	if (needle.length === 0) return [];
	let hay = "";
	const owner: number[] = [];
	const origin: number[] = [];
	segments.forEach((segment, k) => {
		const { chars, map } = normalizeForMatch(segment);
		hay += chars;
		for (let c = 0; c < chars.length; c++) {
			owner.push(k);
			origin.push(map[c]!);
		}
	});
	const out: LocatedRange[] = [];
	for (let from = 0; ; ) {
		const at = hay.indexOf(needle, from);
		if (at < 0) break;
		const last = at + needle.length - 1;
		const endSegment = owner[last]!;
		const endOrigin = origin[last]!;
		const cpLength = segments[endSegment]!.codePointAt(endOrigin)! > 0xffff ? 2 : 1;
		out.push({
			start: { segment: owner[at]!, offset: origin[at]! },
			end: { segment: endSegment, offset: endOrigin + cpLength },
		});
		from = at + needle.length;
	}
	return out;
}
