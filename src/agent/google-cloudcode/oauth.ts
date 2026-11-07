/**
 * Google OAuth (PKCE + loopback callback) for the Cloud Code Assist providers,
 * ported from @mariozechner/pi-ai@0.55.0 `utils/oauth/google-{gemini-cli,antigravity}.js`
 * onto pi-ai 1.4's `OAuthAuth`.
 *
 * Login never touches the browser or stdout: the authorization URL goes out
 * through `interaction.notify({ type: "auth_url" })`, and the user may paste the
 * redirect URL (or bare code) through a `manual_code` prompt that races the
 * 127.0.0.1 callback server. The server is closed on completion, failure and abort.
 */
import type { AuthEvent, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type CloudCodeCredential, encodeApiKey, isCloudCodeCredential } from "./credentials.ts";
import { ANTIGRAVITY_DAILY_ENDPOINT, CLOUDCODE_ENDPOINT } from "./models.ts";

const decode = (s: string): string => atob(s);

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
/** Access tokens are treated as expired this long before Google says so. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface OAuthClient {
	clientId: string;
	clientSecret: string;
}

/** Public installed-app OAuth clients, same values (base64 as in the reference) as the 0.55 providers. */
export const GEMINI_CLI_CLIENT: OAuthClient = {
	clientId: decode("NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t"),
	clientSecret: decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw="),
};
export const ANTIGRAVITY_CLIENT: OAuthClient = {
	clientId: decode("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=="),
	clientSecret: decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY="),
};

const GEMINI_CLI_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];
const ANTIGRAVITY_SCOPES = [
	...GEMINI_CLI_SCOPES,
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

/** Used when Antigravity project discovery finds nothing. */
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";
const PROJECT_ENV_HINT =
	"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
	"See https://goo.gle/gemini-cli-auth-docs#workspace-gca";

type Progress = (message: string) => void;
type ProjectDiscovery = (accessToken: string, onProgress: Progress, signal?: AbortSignal) => Promise<string>;

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Login cancelled"));
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Login cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

// ---------------------------------------------------------------------------
// Loopback callback server (127.0.0.1 only)
// ---------------------------------------------------------------------------

export interface CallbackServer {
	/** Resolves with the authorization code, or `undefined` after `cancel()`. Rejects on provider error, abort or close. */
	wait(): Promise<string | undefined>;
	cancel(): void;
	close(): void;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, detail: string): string =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;

function send(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(html);
}

export async function startCallbackServer(options: {
	port: number;
	path: string;
	/** Callbacks whose `state` differs are rejected with 400 and ignored. */
	state: string;
	providerName: string;
	signal: AbortSignal;
}): Promise<CallbackServer> {
	const { signal, providerName } = options;
	if (signal.aborted) throw new Error("Login cancelled");

	let settled = false;
	let resolveWait: (code: string | undefined) => void = () => {};
	let rejectWait: (error: Error) => void = () => {};
	const waiting = new Promise<string | undefined>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	waiting.catch(() => undefined); // a closed/cancelled wait may never be observed

	const finish = (result: { code: string | undefined } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		signal.removeEventListener("abort", onAbort);
		if ("error" in result) rejectWait(result.error);
		else resolveWait(result.code);
	};
	const onAbort = (): void => finish({ error: new Error("Login cancelled") });

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method !== "GET" || url.pathname !== options.path) return send(res, 404, page("Not found", "Callback route not found."));
		if (url.searchParams.get("state") !== options.state) return send(res, 400, page("Authentication failed", "State mismatch."));
		if (settled) return send(res, 409, page("Authentication failed", "This sign-in has already been handled."));
		const error = url.searchParams.get("error");
		if (error) {
			send(res, 400, page("Authentication failed", `Error: ${error}. You can close this window.`));
			return finish({ error: new Error(`${providerName} authorization failed: ${error}`) });
		}
		const code = url.searchParams.get("code");
		if (!code) return send(res, 400, page("Authentication failed", "Missing authorization code."));
		send(res, 200, page("Authentication successful", "You can close this window and return to the app."));
		finish({ code });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.on("error", (error) => finish({ error }));
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();

	return {
		wait: () => waiting,
		cancel: () => finish({ code: undefined }),
		close: () => {
			finish({ error: new Error("OAuth callback server closed") });
			server.close();
			server.closeAllConnections();
		},
	};
}

/** Accepts a full redirect URL, a `code=...&state=...` query string, or a bare code. */
export function parseAuthorizationInput(input: string, expectedState: string): string {
	const value = input.trim();
	if (!value) throw new Error("No authorization code received");
	let params: URLSearchParams | undefined;
	try {
		params = new URL(value).searchParams;
	} catch {
		if (value.includes("code=")) params = new URLSearchParams(value.replace(/^\?/, ""));
	}
	if (!params) return value;
	const error = params.get("error");
	if (error) throw new Error(`Authorization failed: ${error}`);
	const state = params.get("state");
	if (state && state !== expectedState) throw new Error("OAuth state mismatch - possible CSRF attack");
	const code = params.get("code");
	if (!code) throw new Error("No authorization code received");
	return code;
}

/** Races the callback server against a pasted redirect URL / code. Resolves with the authorization code. */
async function waitForAuthorizationCode(
	interaction: ProviderAuthInteraction,
	server: CallbackServer | undefined,
	state: string,
	redirectUri: string,
): Promise<string> {
	const manualAbort = new AbortController();
	let manualError: Error | undefined;
	const manual = interaction
		.prompt({
			type: "manual_code",
			message: "If the browser cannot reach this machine, paste the final redirect URL (or the authorization code) here.",
			placeholder: `${redirectUri}?code=...`,
			signal: manualAbort.signal,
		})
		.then((input) => {
			server?.cancel();
			return input;
		})
		.catch((error: unknown) => {
			manualError = toError(error);
			server?.cancel();
			return undefined;
		});
	try {
		const code = await server?.wait();
		if (manualError) throw manualError;
		if (code !== undefined) return code;
		const input = await manual;
		if (manualError) throw manualError;
		return parseAuthorizationInput(input ?? "", state);
	} finally {
		manualAbort.abort();
	}
}

// ---------------------------------------------------------------------------
// Tokens / user info
// ---------------------------------------------------------------------------

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

async function postToken(client: OAuthClient, params: Record<string, string>, failure: string, signal?: AbortSignal): Promise<TokenResponse> {
	const response = await globalThis.fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }),
		signal,
	});
	if (!response.ok) throw new Error(`${failure}: ${await response.text()}`);
	const data: Partial<TokenResponse> = await response.json();
	if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
		throw new Error(`${failure}: malformed token response`);
	}
	return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in };
}

async function getUserEmail(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const response = await globalThis.fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
		if (!response.ok) return undefined;
		const info: { email?: string } = await response.json();
		return info.email;
	} catch {
		// the email is only a label
		return undefined;
	}
}

const expiresAt = (expiresInSeconds: number): number => Date.now() + expiresInSeconds * 1000 - EXPIRY_BUFFER_MS;

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

interface LoadCodeAssistResponse {
	currentTier?: { id?: string };
	cloudaicompanionProject?: string | { id?: string };
	allowedTiers?: { id?: string; isDefault?: boolean }[];
}

interface OperationResponse {
	name?: string;
	done?: boolean;
	response?: { cloudaicompanionProject?: { id?: string } };
}

const projectIdOf = (value: LoadCodeAssistResponse["cloudaicompanionProject"]): string | undefined =>
	typeof value === "string" ? value || undefined : value?.id || undefined;

function isVpcScAffectedUser(errorBody: string): boolean {
	let payload: { error?: { details?: { reason?: string }[] } } | null;
	try {
		payload = JSON.parse(errorBody);
	} catch {
		return false;
	}
	const details = payload?.error?.details;
	return Array.isArray(details) && details.some((detail) => detail.reason === "SECURITY_POLICY_VIOLATED");
}

async function pollOperation(operationName: string, headers: Record<string, string>, onProgress: Progress, signal?: AbortSignal): Promise<OperationResponse> {
	for (let attempt = 0; ; attempt++) {
		if (attempt > 0) {
			onProgress(`Waiting for project provisioning (attempt ${attempt + 1})...`);
			await sleep(5000, signal);
		}
		const response = await globalThis.fetch(`${CLOUDCODE_ENDPOINT}/v1internal/${operationName}`, { method: "GET", headers, signal });
		if (!response.ok) throw new Error(`Failed to poll operation: ${response.status} ${response.statusText}`);
		const data: OperationResponse = await response.json();
		if (data.done) return data;
	}
}

/** Gemini CLI: use the existing managed project, or onboard onto the default tier. */
export const discoverGeminiCliProject: ProjectDiscovery = async (accessToken, onProgress, signal) => {
	const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	onProgress("Checking for existing Cloud Code Assist project...");
	const loadResponse = await globalThis.fetch(`${CLOUDCODE_ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({
			cloudaicompanionProject: envProjectId,
			metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI", duetProject: envProjectId },
		}),
	});
	let data: LoadCodeAssistResponse;
	if (loadResponse.ok) {
		data = await loadResponse.json();
	} else {
		const errorText = await loadResponse.text();
		if (!isVpcScAffectedUser(errorText)) {
			throw new Error(`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`);
		}
		data = { currentTier: { id: TIER_STANDARD } };
	}

	if (data.currentTier) {
		const existing = projectIdOf(data.cloudaicompanionProject);
		if (existing) return existing;
		if (envProjectId) return envProjectId;
		throw new Error(PROJECT_ENV_HINT);
	}

	const tierId = (data.allowedTiers?.find((tier) => tier.isDefault) ?? { id: TIER_LEGACY }).id ?? TIER_FREE;
	if (tierId !== TIER_FREE && !envProjectId) throw new Error(PROJECT_ENV_HINT);

	onProgress("Provisioning Cloud Code Assist project (this may take a moment)...");
	// Free tier: Google provisions the project. Other tiers: bring your own.
	const onboardBody: { tierId: string; metadata: Record<string, string>; cloudaicompanionProject?: string } = {
		tierId,
		metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
	};
	if (tierId !== TIER_FREE && envProjectId) {
		onboardBody.cloudaicompanionProject = envProjectId;
		onboardBody.metadata.duetProject = envProjectId;
	}
	const onboardResponse = await globalThis.fetch(`${CLOUDCODE_ENDPOINT}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify(onboardBody),
	});
	if (!onboardResponse.ok) {
		throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${await onboardResponse.text()}`);
	}
	let operation: OperationResponse = await onboardResponse.json();
	if (!operation.done && operation.name) operation = await pollOperation(operation.name, headers, onProgress, signal);

	const projectId = operation.response?.cloudaicompanionProject?.id;
	if (projectId) return projectId;
	if (envProjectId) return envProjectId;
	throw new Error(
		"Could not discover or provision a Google Cloud project. " +
			"Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
			"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
	);
};

/** Antigravity: ask prod then the daily sandbox for a project; fall back to the shared default. */
export const discoverAntigravityProject: ProjectDiscovery = async (accessToken, onProgress, signal) => {
	const metadata = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify(metadata),
	};
	onProgress("Checking for existing project...");
	for (const endpoint of [CLOUDCODE_ENDPOINT, ANTIGRAVITY_DAILY_ENDPOINT]) {
		try {
			const response = await globalThis.fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers,
				signal,
				body: JSON.stringify({ metadata }),
			});
			if (!response.ok) continue;
			const data: LoadCodeAssistResponse = await response.json();
			const projectId = projectIdOf(data.cloudaicompanionProject);
			if (projectId) return projectId;
		} catch (error) {
			if (signal?.aborted) throw toError(error);
			// try the next endpoint
		}
	}
	onProgress("Using default project...");
	return ANTIGRAVITY_DEFAULT_PROJECT_ID;
};

// ---------------------------------------------------------------------------
// The OAuthAuth
// ---------------------------------------------------------------------------

interface FlowConfig {
	/** Shown in progress/error text. */
	name: string;
	client: OAuthClient;
	scopes: readonly string[];
	callbackPort: number;
	callbackPath: string;
	/** Registered with the OAuth client; the host must stay `localhost`. */
	redirectUri: string;
	discoverProject: ProjectDiscovery;
}

function cloudCodeOAuth(config: FlowConfig): OAuthAuth {
	return {
		name: config.name,
		isSubscription: true,

		async login(interaction): Promise<OAuthCredential> {
			const { signal } = interaction;
			const progress: Progress = (message) => {
				const event: AuthEvent = { type: "progress", message };
				interaction.notify(event);
			};
			const { verifier, challenge } = await generatePKCE();
			const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

			progress("Starting local server for OAuth callback...");
			let server: CallbackServer | undefined;
			try {
				server = await startCallbackServer({
					port: config.callbackPort,
					path: config.callbackPath,
					state,
					providerName: config.name,
					signal,
				});
			} catch (error) {
				if (signal.aborted) throw toError(error);
				progress(`Could not start the local callback server (${toError(error).message}); paste the redirect URL after signing in.`);
			}

			try {
				const authParams = new URLSearchParams({
					client_id: config.client.clientId,
					response_type: "code",
					redirect_uri: config.redirectUri,
					scope: config.scopes.join(" "),
					code_challenge: challenge,
					code_challenge_method: "S256",
					state,
					access_type: "offline",
					prompt: "consent",
				});
				interaction.notify({ type: "auth_url", url: `${AUTH_URL}?${authParams}`, instructions: "Complete the sign-in in your browser." });

				progress("Waiting for OAuth callback...");
				const code = await waitForAuthorizationCode(interaction, server, state, config.redirectUri);

				progress("Exchanging authorization code for tokens...");
				const tokens = await postToken(
					config.client,
					{ code, grant_type: "authorization_code", redirect_uri: config.redirectUri, code_verifier: verifier },
					"Token exchange failed",
					signal,
				);
				if (!tokens.refresh_token) throw new Error("No refresh token received. Please try again.");

				progress("Getting user info...");
				const email = await getUserEmail(tokens.access_token, signal);
				const projectId = await config.discoverProject(tokens.access_token, progress, signal);

				const credential: CloudCodeCredential = {
					type: "oauth",
					refresh: tokens.refresh_token,
					access: tokens.access_token,
					expires: expiresAt(tokens.expires_in),
					projectId,
					...(email ? { email } : {}),
				};
				return credential;
			} finally {
				server?.close();
			}
		},

		async refresh(credential, signal): Promise<OAuthCredential> {
			if (!isCloudCodeCredential(credential)) throw new Error(`${config.name} credentials missing projectId`);
			const tokens = await postToken(
				config.client,
				{ refresh_token: credential.refresh, grant_type: "refresh_token" },
				`${config.name} token refresh failed`,
				signal,
			);
			const refreshed: CloudCodeCredential = {
				...credential,
				refresh: tokens.refresh_token || credential.refresh,
				access: tokens.access_token,
				expires: expiresAt(tokens.expires_in),
			};
			return refreshed;
		},

		async toAuth(credential) {
			if (!isCloudCodeCredential(credential)) throw new Error(`${config.name} credentials missing projectId`);
			return { apiKey: encodeApiKey(credential.access, credential.projectId) };
		},
	};
}

export const geminiCliOAuth = (): OAuthAuth =>
	cloudCodeOAuth({
		name: "Google Gemini CLI (Code Assist)",
		client: GEMINI_CLI_CLIENT,
		scopes: GEMINI_CLI_SCOPES,
		callbackPort: 8085,
		callbackPath: "/oauth2callback",
		redirectUri: "http://localhost:8085/oauth2callback",
		discoverProject: discoverGeminiCliProject,
	});

export const antigravityOAuth = (): OAuthAuth =>
	cloudCodeOAuth({
		name: "Google Antigravity",
		client: ANTIGRAVITY_CLIENT,
		scopes: ANTIGRAVITY_SCOPES,
		callbackPort: 51121,
		callbackPath: "/oauth-callback",
		redirectUri: "http://localhost:51121/oauth-callback",
		discoverProject: discoverAntigravityProject,
	});
