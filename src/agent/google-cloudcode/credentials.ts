/**
 * Credential shape + the access-token hand-off between OAuth and the stream.
 *
 * Stored credential (pi-ai `OAuthCredential` plus two provider fields):
 *   { type: "oauth", refresh, access, expires, projectId, email? }
 *
 * pi-ai's `ModelAuth` has no slot for a project id, so `toAuth` returns
 * `{ apiKey: JSON.stringify({ token, projectId }) }` and the stream decodes it
 * with `decodeApiKey` (same hand-off the 0.55 providers used).
 */
import type { OAuthCredential } from "@earendil-works/pi-ai";

export interface CloudCodeCredential extends OAuthCredential {
	/** Cloud Code Assist project the requests are billed/routed to. */
	projectId: string;
	email?: string;
}

export function isCloudCodeCredential(credential: OAuthCredential): credential is CloudCodeCredential {
	return typeof credential.projectId === "string" && credential.projectId.length > 0;
}

export function encodeApiKey(token: string, projectId: string): string {
	return JSON.stringify({ token, projectId });
}

export function decodeApiKey(raw: string | undefined): { token: string; projectId: string } {
	if (!raw) throw new Error("Google Cloud Code Assist requires OAuth authentication. Sign in again.");
	let parsed: { token?: unknown; projectId?: unknown };
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Invalid Google Cloud Code Assist credentials. Sign in again.");
	}
	if (typeof parsed.token !== "string" || !parsed.token || typeof parsed.projectId !== "string" || !parsed.projectId) {
		throw new Error("Missing token or projectId in Google Cloud credentials. Sign in again.");
	}
	return { token: parsed.token, projectId: parsed.projectId };
}
