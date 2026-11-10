/**
 * Subscription (OAuth plan) logins (subscriptions wave): the server side of
 * "use my Claude Pro/Max / Copilot / ChatGPT / Gemini / Antigravity plan
 * instead of an API key".
 *
 * pi-ai owns every provider's login flow (PKCE, device code, localhost
 * callback server) and the credential refresh; this module only RELAYS the
 * flow's interaction to the browser UI through a polled LOGIN SESSION:
 *
 *   POST   /api/subscriptions/:provider/login        → start, returns the session
 *   GET    /api/subscriptions/sessions/:sid             → poll (events, open prompt, status)
 *   POST   /api/subscriptions/sessions/:sid             → answer the open prompt
 *   DELETE /api/subscriptions/sessions/:sid             → cancel
 *   DELETE /api/subscriptions/:provider              → log out (drop the credential)
 *
 * The flow runs inside this process; its callback server binds the machine
 * the app runs on (desktop = the user's machine). A `manual_code` prompt is
 * the paste-the-redirect-URL fallback for when the browser is elsewhere.
 *
 * Sessions live on globalThis (HMR / per-route bundles share them), are
 * capped, time out, and finished ones are swept — a stuck flow can never
 * pin a callback port forever.
 */

import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { piModels } from "../agent/models.ts";
import {
	SUBSCRIPTION_CAVEATS,
	type LoginEvent,
	type LoginPrompt,
	type LoginSessionView,
	type SubscriptionProviderInfo,
} from "../core/subscriptions.ts";
import { credentialStore } from "../store/credentials.ts";
import "./providers.ts"; // installs the credential store into piModels()
import { refreshConnectionCatalog } from "./model-catalog.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const FINISHED_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 16;
const MAX_EVENTS = 50;

interface Session {
	view: LoginSessionView;
	controller: AbortController;
	/** Resolves/rejects the open prompt the flow is awaiting. */
	answer: { promptId: string; resolve: (value: string) => void; reject: (error: Error) => void } | null;
	timer: ReturnType<typeof setTimeout>;
	finishedAt: number | null;
}

const SESSIONS_KEY = Symbol.for("lh.loginSessions");
function sessions(): Map<string, Session> {
	const g = globalThis as Record<symbol, Map<string, Session> | undefined>;
	return (g[SESSIONS_KEY] ??= new Map());
}

/** Providers that offer an OAuth login, with connection state. */
export function subscriptionProviders(): SubscriptionProviderInfo[] {
	const out: SubscriptionProviderInfo[] = [];
	for (const provider of piModels().getProviders()) {
		const oauth = provider.auth.oauth;
		if (!oauth) continue;
		out.push({
			id: provider.id,
			name: oauth.name,
			isSubscription: oauth.isSubscription === true,
			connected: credentialStore.typeOf(provider.id) === "oauth",
			...(SUBSCRIPTION_CAVEATS[provider.id] ? { caveat: SUBSCRIPTION_CAVEATS[provider.id] } : {}),
		});
	}
	// Plans first, then the rest; stable by name.
	return out.sort((a, b) => Number(b.isSubscription) - Number(a.isSubscription) || a.name.localeCompare(b.name));
}

function sweep(): void {
	const now = Date.now();
	for (const [id, s] of sessions()) {
		if (s.finishedAt !== null && now - s.finishedAt > FINISHED_TTL_MS) sessions().delete(id);
	}
}

function finish(session: Session, status: "succeeded" | "failed" | "cancelled", error: string | null = null): void {
	if (session.finishedAt !== null) return;
	clearTimeout(session.timer);
	session.finishedAt = Date.now();
	session.view.status = status;
	session.view.error = error;
	session.view.prompt = null;
	session.answer = null;
}

function toLoginEvent(event: AuthEvent): LoginEvent {
	switch (event.type) {
		case "auth_url":
			return { type: "auth_url", url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) };
		case "device_code":
			return {
				type: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
				...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
			};
		case "info":
			return { type: "info", message: event.message, ...(event.links ? { links: event.links.map((l) => ({ ...l })) } : {}) };
		case "progress":
			return { type: "progress", message: event.message };
	}
}

function toLoginPrompt(id: string, prompt: AuthPrompt): LoginPrompt {
	const base = { id, type: prompt.type, message: prompt.message };
	switch (prompt.type) {
		case "select":
			return { ...base, type: "select", options: prompt.options.map((o) => ({ ...o })) };
		case "text":
		case "secret":
		case "manual_code":
			return { ...base, ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}) };
	}
}

/** Redact: a flow's error text must never echo a token. pi-ai errors name
 *  the failing step, not the secret; this is belt-and-braces. */
function safeMessage(err: unknown): string {
	const text = err instanceof Error ? err.message : String(err);
	return text.replace(/[A-Za-z0-9_\-.]{32,}/g, "…").slice(0, 400);
}

export type StartLogin = { ok: true; session: LoginSessionView } | { ok: false; status: 404 | 429; error: string };

export function startLogin(providerId: string): StartLogin {
	sweep();
	const provider = piModels().getProvider(providerId);
	if (!provider?.auth.oauth) return { ok: false, status: 404, error: `"${providerId}" has no subscription login` };
	// One live flow per provider: a retry supersedes the stuck one (frees its callback port).
	for (const s of sessions().values()) {
		if (s.view.providerId === providerId && s.finishedAt === null) {
			s.controller.abort();
			s.answer?.reject(new Error("superseded"));
			finish(s, "cancelled");
		}
	}
	if (sessions().size >= MAX_SESSIONS) return { ok: false, status: 429, error: "too many login sessions — try again shortly" };

	const controller = new AbortController();
	const session: Session = {
		view: { id: randomUUID(), providerId, status: "running", events: [], prompt: null, error: null },
		controller,
		answer: null,
		timer: setTimeout(() => {
			controller.abort();
			session.answer?.reject(new Error("timed out"));
			finish(session, "failed", "Sign-in timed out. Try again.");
		}, LOGIN_TIMEOUT_MS),
		finishedAt: null,
	};
	sessions().set(session.view.id, session);

	const interaction = {
		signal: controller.signal,
		notify(event: AuthEvent) {
			session.view.events.push(toLoginEvent(event));
			if (session.view.events.length > MAX_EVENTS) session.view.events.shift();
		},
		prompt(prompt: AuthPrompt): Promise<string> {
			return new Promise<string>((resolve, reject) => {
				const promptId = randomUUID();
				const settle = () => {
					prompt.signal?.removeEventListener("abort", onPromptAbort);
					if (session.answer?.promptId === promptId) {
						session.answer = null;
						session.view.prompt = null;
					}
				};
				// pi-ai aborts a prompt out-of-band when another path resolved
				// the step (the callback server won the race against a pasted code).
				const onPromptAbort = () => {
					settle();
					reject(new Error("prompt cancelled"));
				};
				if (prompt.signal?.aborted) return reject(new Error("prompt cancelled"));
				prompt.signal?.addEventListener("abort", onPromptAbort, { once: true });
				session.answer = {
					promptId,
					resolve: (value) => {
						settle();
						resolve(value);
					},
					reject: (error) => {
						settle();
						reject(error);
					},
				};
				session.view.prompt = toLoginPrompt(promptId, prompt);
			});
		},
	};

	void piModels()
		.login(providerId, "oauth", interaction)
		.then(
			() => {
				finish(session, "succeeded");
				// A new login may serve a different model lineup: fetch it now so the picker is current at once.
				void refreshConnectionCatalog(providerId).catch(() => {});
			},
			(err: unknown) => {
				if (session.finishedAt !== null) return; // cancelled / timed out already
				finish(session, controller.signal.aborted ? "cancelled" : "failed", controller.signal.aborted ? null : safeMessage(err));
			},
		);

	return { ok: true, session: snapshot(session) };
}

function snapshot(session: Session): LoginSessionView {
	return structuredClone(session.view);
}

export function getLoginSession(id: string): LoginSessionView | null {
	sweep();
	const session = sessions().get(id);
	return session ? snapshot(session) : null;
}

export type AnswerResult = { ok: true; session: LoginSessionView } | { ok: false; status: 404 | 409; error: string };

/** Answer the open prompt. `promptId` guards against answering a stale prompt. */
export function answerLoginPrompt(id: string, promptId: string, value: string): AnswerResult {
	const session = sessions().get(id);
	if (!session) return { ok: false, status: 404, error: "unknown login session" };
	if (!session.answer || session.answer.promptId !== promptId) return { ok: false, status: 409, error: "that question is no longer open" };
	session.answer.resolve(value);
	return { ok: true, session: snapshot(session) };
}

export function cancelLogin(id: string): LoginSessionView | null {
	const session = sessions().get(id);
	if (!session) return null;
	if (session.finishedAt === null) {
		session.controller.abort();
		session.answer?.reject(new Error("cancelled"));
		finish(session, "cancelled");
	}
	return snapshot(session);
}

/** Log out: drop the stored OAuth credential (idempotent). Only an OAuth
 *  credential is removed — a custom provider's API key is managed through
 *  /api/providers, never here. */
export async function logoutSubscription(providerId: string): Promise<boolean> {
	if (credentialStore.typeOf(providerId) !== "oauth") return false;
	await piModels().logout(providerId);
	return true;
}
