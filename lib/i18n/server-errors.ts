/**
 * Maps server-originated English error text to the active dictionary at
 * render time. The server keeps English; exact messages are derived from the
 * English `errors` dictionary (every string leaf is an exact server literal),
 * interpolated messages are matched by the regex list below (capture groups
 * are passed to the dictionary function in order). Unknown text is returned
 * unchanged.
 */

import { en, type Messages } from "./messages";

type Errors = Messages["errors"];
type Group = keyof Errors;

const exact = new Map<string, (t: Messages) => string>();
for (const group of Object.keys(en.errors) as Group[]) {
	const entries = en.errors[group] as Record<string, unknown>;
	for (const key of Object.keys(entries)) {
		const value = entries[key];
		if (typeof value !== "string") continue;
		exact.set(value, (t) => (t.errors[group] as Record<string, string>)[key]!);
	}
}

/** Build a regex row for a function entry `t.errors[group][key]`. */
function row(
	pattern: RegExp,
	group: Group,
	key: string,
): [RegExp, (t: Messages, ...groups: string[]) => string] {
	return [
		pattern,
		(t, ...groups) => (t.errors[group] as unknown as Record<string, (...a: string[]) => string>)[key]!(...groups),
	];
}

// More specific patterns precede generic ones.
const patterns: Array<[RegExp, (t: Messages, ...groups: string[]) => string]> = [
	row(/^(.+) must be at least (12) characters with no whitespace$/, "keys", "providerMinimumLength"),
	row(/^(.+) must be at least (\d+) characters with no whitespace$/, "keys", "minimumLength"),
	row(/^(.+) must start with "tvly-" \(Tavily's key format\)$/, "keys", "tavilyPrefix"),
	row(/^(.+) must start with "fc-" \(Firecrawl's key format\)$/, "keys", "firecrawlPrefix"),
	row(/^(.+) must be a positive integer$/, "customProviders", "positiveInteger"),
	row(/^(.+)\.id is required \(no whitespace, max (\d+) chars\)$/, "customProviders", "modelIdRequired"),
	row(/^(.+)\.name must be a string up to (\d+) chars$/, "customProviders", "modelNameLength"),
	row(/^(.+)\.maxTokens cannot exceed contextWindow$/, "customProviders", "maxTokensExceedContext"),
	row(/^id "(.+)" is reserved by a built-in provider — pick another$/, "customProviders", "reservedId"),
	row(/^name is required \(max (\d+) chars\)$/, "customProviders", "nameRequired"),
	row(/^at most (\d+) models per provider$/, "customProviders", "tooManyModels"),
	row(/^duplicate model id "(.+)"$/, "customProviders", "duplicateModel"),
	row(/^(.+) must be a #hex color or null$/, "settings", "hexColor"),
	row(
		/^extractionChunkTokens must be at least (\d+) \(smaller batches waste the per-run graph overhead\)$/,
		"settings",
		"extractionChunkMinimum",
	),
	row(
		/^thresholdTokens must be at least (\d+) \(compaction keeps a ~20k-token recent tail — smaller budgets would churn it\)$/,
		"settings",
		"compactionThresholdMinimum",
	),
	row(/^Unknown provider "(.+)" — configured: (.*)$/, "settings", "unknownProvider"),
	row(/^No model "(.+)" in the (.+) catalog$/, "settings", "modelMissing"),
	row(/^"(.+)" is not a current source segment$/, "settings", "promptSegmentStale"),
	row(
		/^(.+)\. If this endpoint has no \/models list, add model IDs manually\.$/,
		"customEndpoint",
		"discoveryWithManualHint",
	),
	row(/^(.+) for (.+) must be a whole number of tokens at least (\d+)$/, "customEndpoint", "pinMinimum"),
	row(/^Endpoint returned HTTP (\d+)$/, "customEndpoint", "httpStatus"),
	row(/^No (.+) key is set — add one in Settings → Keys$/, "models", "providerKeyMissing"),
	row(/^Deepgram token grant failed \((\d+)\): ([\s\S]*)$/, "dictation", "tokenGrantFailed"),
];

export function localizeServerError(text: string, t: Messages): string {
	const hit = exact.get(text);
	if (hit) return hit(t);
	for (const [re, fn] of patterns) {
		const m = re.exec(text);
		if (m) return fn(t, ...m.slice(1));
	}
	return text;
}
