/**
 * SUBSCRIPTION LOGIN CONTRACT (subscriptions wave): the browser-safe shapes
 * the settings UI and /api/subscriptions* routes share. A "subscription" is
 * an OAuth login to a paid plan (Claude Pro/Max, GitHub Copilot, ChatGPT /
 * Codex, Gemini CLI, Antigravity …) used INSTEAD of an API key. The login
 * flow is provider-owned (pi-ai drives PKCE / device-code / callback
 * servers); the server relays its interaction — URLs to open, codes to
 * show, prompts to answer — through a polled login session.
 */

export interface SubscriptionProviderInfo {
	/** pi-ai provider id (the same id model pins use: `provider:id`). */
	id: string;
	/** The OAuth method's display name, e.g. "Anthropic (Claude Pro/Max)". */
	name: string;
	/** True when pi-ai marks the OAuth method as backed by a paid plan. */
	isSubscription: boolean;
	/** A stored OAuth credential exists for this provider. */
	connected: boolean;
	/** Honest caveat shown next to the connect button (terms-of-service
	 *  risk, plan limits). Absent when there is nothing to warn about. */
	caveat?: string;
}

/** Caveats the UI shows before connecting. Keyed by provider id. */
export const SUBSCRIPTION_CAVEATS: Readonly<Record<string, string>> = {
	anthropic: "Anthropic's terms restrict using Claude subscription tokens outside its own apps; accounts may be limited. Use at your own risk.",
	"google-gemini-cli": "Uses Google's Gemini CLI / Code Assist login. Google may restrict third-party use of this login; use at your own risk.",
	"google-antigravity": "Uses Google's Antigravity login. Google may restrict third-party use of this login and has suspended accounts for it; use at your own risk.",
	"github-copilot": "Requests count against your Copilot plan; GitHub's terms apply.",
	"openai-codex": "Requests count against your ChatGPT plan limits.",
};

export type LoginEvent =
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "progress"; message: string };

/** A question the provider's login flow is waiting on. */
export interface LoginPrompt {
	/** Answer token: POST it back with the response. */
	id: string;
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: { id: string; label: string; description?: string }[];
}

export type LoginStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface LoginSessionView {
	id: string;
	providerId: string;
	status: LoginStatus;
	/** Every event so far, oldest first (the UI renders the latest url/code). */
	events: LoginEvent[];
	/** The open question, if the flow is waiting on the user. */
	prompt: LoginPrompt | null;
	/** Set when status is "failed". */
	error: string | null;
}
