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
import { createProvider, type Provider } from "@earendil-works/pi-ai";
import { antigravityOAuth, geminiCliOAuth } from "./oauth.ts";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_DAILY_ENDPOINT, CLOUDCODE_ENDPOINT, GEMINI_CLI_MODELS, GEMINI_CLI_PROVIDER_ID } from "./models.ts";
import { cloudCodeStreams } from "./stream.ts";

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

export function antigravityProvider(): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER_ID,
		name: "Google Antigravity",
		baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
		auth: { oauth: antigravityOAuth() },
		models: ANTIGRAVITY_MODELS,
		api: cloudCodeStreams,
	});
}
