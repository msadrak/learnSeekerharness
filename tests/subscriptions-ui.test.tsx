import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SubscriptionsList } from "../components/settings/subscriptions.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (root) await act(async () => root!.unmount());
	host?.remove();
	root = host = undefined;
});

const providers = { providers: [{ id: "anthropic", name: "Anthropic", isSubscription: true, connected: false }] };
const running = { id: "sid-1", providerId: "anthropic", status: "running", events: [], prompt: null, error: null };
const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<SubscriptionsList />));
	await act(async () => sleep(0));
}

test("Connect shows the signing-in state immediately, while the login request is still pending", async () => {
	const pending = Promise.withResolvers<Response>();
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url === "/api/subscriptions/providers") return Response.json(providers);
		if (url === "/api/subscriptions/anthropic/login" && init?.method === "POST") return pending.promise;
		throw new Error(`unexpected ${url}`);
	}) as typeof fetch;
	await mount();
	await act(async () => byTest("subscription-anthropic-connect")!.click());
	assert.match(byTest("subscription-login-starting")?.textContent ?? "", /Starting sign-in/);
	assert.match(byTest("subscription-anthropic-connect")!.textContent!, /Signing in/);
	await act(async () => pending.resolve(Response.json({ error: "boom" }, { status: 500 })));
	assert.equal(byTest("subscription-login-starting"), null);
	assert.equal(byTest("subscriptions-error")?.textContent, "boom");
});

test("a login whose status poll fails is abandoned with the error shown, not left spinning", async () => {
	const calls: string[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/subscriptions/providers") return Response.json(providers);
		if (url === "/api/subscriptions/anthropic/login") return Response.json({ session: running });
		if (url === "/api/subscriptions/sessions/sid-1" && init?.method === "DELETE") return Response.json({ session: running });
		if (url === "/api/subscriptions/sessions/sid-1") return Response.json({ error: "unknown login session" }, { status: 404 });
		throw new Error(`unexpected ${url}`);
	}) as typeof fetch;
	await mount();
	await act(async () => byTest("subscription-anthropic-connect")!.click());
	assert(byTest("subscription-login-panel"));
	await act(async () => sleep(1300));
	assert.equal(byTest("subscription-login-panel"), null);
	assert.equal(byTest("subscriptions-error")?.textContent, "unknown login session");
	assert(calls.includes("DELETE /api/subscriptions/sessions/sid-1"), "the dead session is cancelled server-side");
	assert.match(byTest("subscription-anthropic-connect")!.textContent!, /Connect/);
});
