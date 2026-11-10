/**
 * Google Cloud Code Assist providers dropped from pi-ai 1.4: "Gemini CLI" login
 * and "Antigravity" login, both OAuth subscriptions.
 *
 * Auth hand-off: the stored credential is
 *   { type: "oauth", refresh, access, expires, projectId, email? }
 * and `toAuth` exposes it as `{ apiKey: JSON.stringify({ token, projectId }) }`;
 * the stream decodes that apiKey (credentials.ts). Models use the custom api id
 * "google-gemini-cli" for both providers (models.ts); the provider id picks the
 * endpoint and request quirks.
 *
 * No network, browser or stdout access happens at import or at provider
 * construction; OAuth login is driven entirely through the interaction passed
 * to `login()`.
 */
import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { isCloudCodeCredential } from "./credentials.ts";
import { antigravityOAuth, geminiCliOAuth } from "./oauth.ts";
import type { ModelListingStore } from "../../core/ports.ts";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_DAILY_ENDPOINT, CLOUDCODE_ENDPOINT, GEMINI_CLI_MODELS, GEMINI_CLI_PROVIDER_ID, antigravityModelsFromListing } from "./models.ts";
import { cloudCodeStreams, fetchAntigravityListing } from "./stream.ts";

export function geminiCliProvider(): Provider {
	return createProvider({
		id: GEMINI_CLI_PROVIDER_ID,
		name: "Google Gemini CLI (Code Assist)",
		baseUrl: CLOUDCODE_ENDPOINT,
		auth: { oauth: geminiCliOAuth() },
		models: GEMINI_CLI_MODELS,
		api: cloudCodeStreams,
	});
}

/** A fetched list stays fresh this long; a failed fetch is not retried before the backoff; one fetch waits at most the timeout. */
const LISTING_FRESH_MS = 10 * 60_000;
const LISTING_FAILURE_BACKOFF_MS = 60_000;
const LISTING_TIMEOUT_MS = 8_000;

/**
 * Antigravity's models are whatever Google serves THIS account: `refreshModels` asks Google (see fetchAntigravityListing) and the
 * answer replaces the list — not merged over the built-in one, so a model Google retired disappears. Every good answer is
 * saved (`saved`) and read back when the provider is rebuilt. The built-in list (models.ts) is only what shows before any
 * answer has ever been fetched, and what stays when nothing better is known.
 */
export function antigravityProvider(saved?: ModelListingStore): Provider {
	const base = createProvider({
		id: ANTIGRAVITY_PROVIDER_ID,
		name: "Google Antigravity",
		baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
		auth: { oauth: antigravityOAuth() },
		models: ANTIGRAVITY_MODELS,
		api: cloudCodeStreams,
	});
	// What the last good fetch saved: a restart or hot reload starts from it, so a model the learner pinned from Google's list
	// still resolves before the next fetch. A start-up value is never "fresh" (fetchedAt stays 0): the first refresh still asks Google.
	const restored = antigravityModelsFromListing(saved?.read(ANTIGRAVITY_PROVIDER_ID));
	let live: readonly Model<Api>[] | undefined = restored.length > 0 ? restored : undefined;
	let fetchedAt = 0;
	let failedAt = 0;
	const current = (): readonly Model<Api>[] => live ?? base.getModels();
	return {
		...base,
		getModels: current,
		getAllModels: current,
		refreshModels: async (context) => {
			const { credential } = context;
			if (!context.allowNetwork || context.signal.aborted || credential?.type !== "oauth" || !isCloudCodeCredential(credential)) return;
			const now = Date.now();
			if (!context.force && ((live && now - fetchedAt < LISTING_FRESH_MS) || (failedAt > 0 && now - failedAt < LISTING_FAILURE_BACKOFF_MS))) return;
			try {
				const signal = AbortSignal.any([context.signal, AbortSignal.timeout(LISTING_TIMEOUT_MS)]);
				const listing = await fetchAntigravityListing({ token: credential.access, projectId: credential.projectId }, { signal });
				const models = antigravityModelsFromListing(listing);
				if (models.length === 0) throw new Error("Google's model list for this account had no selectable models.");
				if (context.signal.aborted) return;
				await context.publish({
					update: () => {
						live = models;
						fetchedAt = Date.now();
						failedAt = 0;
					},
				});
				try {
					saved?.write(ANTIGRAVITY_PROVIDER_ID, listing);
				} catch (error) {
					// The list in memory is good; only a restart would miss it.
					console.warn(`[models] Antigravity model list not saved: ${error instanceof Error ? error.message : String(error)}`);
				}
			} catch (error) {
				failedAt = Date.now();
				throw error;
			}
		},
	};
}
