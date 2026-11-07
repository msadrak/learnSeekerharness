/**
 * The subscription login-session relay (subscriptions wave): pi-ai owns each
 * provider's OAuth flow; the server relays its interaction (URLs, prompts)
 * to the browser through a polled session. A fake OAuth provider stands in
 * for Anthropic/Copilot/Google — what is under test is OUR relay: events and
 * prompts surface, answers resume the flow, the credential lands in the
 * store, stale answers are refused, cancel frees the flow, and a connected
 * provider federates into the picker.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createProvider, type OAuthAuth, type OAuthCredential } from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subscriptions-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_CREDENTIALS_FILE = path.join(TMP, "credentials.json");

const { answerLoginPrompt, cancelLogin, getLoginSession, logoutSubscription, startLogin, subscriptionProviders } = await import("../src/server/subscriptions.ts");
const { piModels } = await import("../src/agent/models.ts");
const { catalogProviders } = await import("../src/server/model-catalog.ts");
const { credentialStore } = await import("../src/store/credentials.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const credential = (access: string): OAuthCredential => ({ type: "oauth", access, refresh: "r", expires: Date.now() + 3_600_000 });

/** A fake plan login: shows a URL, then waits for a pasted code. */
const fakeOAuth: OAuthAuth = {
	name: "Fake Plan",
	isSubscription: true,
	async login(interaction) {
		interaction.notify({ type: "auth_url", url: "https://login.fake.test/authorize?x=1", instructions: "Sign in" });
		const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
		if (code === "bad") throw new Error("invalid_grant");
		return credential(`tok-${code}`);
	},
	async refresh(c) {
		return c;
	},
	async toAuth(c) {
		return { apiKey: c.access };
	},
};

function installFakeProvider(): void {
	piModels().setProvider(
		createProvider({
			id: "fake-plan",
			name: "Fake Plan",
			auth: { oauth: fakeOAuth },
			models: [],
			api: { stream: () => assert.fail("no requests in this test"), streamSimple: () => assert.fail("no requests in this test") },
		}),
	);
}

async function until<T>(read: () => T | undefined | null, what: string): Promise<T> {
	for (let i = 0; i < 200; i++) {
		const v = read();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.fail(`timed out waiting for ${what}`);
}

describe("subscription login sessions", () => {
	it("lists OAuth-capable providers, including Claude, Copilot, ChatGPT/Codex, Gemini CLI and Antigravity", () => {
		const ids = subscriptionProviders().map((p) => p.id);
		for (const id of ["anthropic", "github-copilot", "openai-codex", "google-gemini-cli", "google-antigravity"]) assert.ok(ids.includes(id), id);
	});

	it("relays the URL, waits on the prompt, and stores the credential once answered", async () => {
		installFakeProvider();
		const started = startLogin("fake-plan");
		assert.ok(started.ok);
		if (!started.ok) return;
		const sid = started.session.id;

		const withPrompt = await until(() => {
			const s = getLoginSession(sid);
			return s?.prompt ? s : null;
		}, "the open prompt");
		assert.equal(withPrompt.status, "running");
		assert.deepEqual(withPrompt.events.map((e) => e.type), ["auth_url"]);
		assert.equal(withPrompt.prompt?.type, "manual_code");

		// A stale/foreign prompt id is refused and does not resume the flow.
		const stale = answerLoginPrompt(sid, "not-the-prompt", "abc");
		assert.equal(stale.ok, false);
		assert.equal(getLoginSession(sid)?.status, "running");

		const answered = answerLoginPrompt(sid, withPrompt.prompt!.id, "abc");
		assert.ok(answered.ok);
		const done = await until(() => {
			const s = getLoginSession(sid);
			return s && s.status !== "running" ? s : null;
		}, "completion");
		assert.equal(done.status, "succeeded");
		assert.equal(done.prompt, null);

		assert.equal(credentialStore.typeOf("fake-plan"), "oauth");
		assert.equal(subscriptionProviders().find((p) => p.id === "fake-plan")?.connected, true);
		// Connected subscription providers federate into the picker's provider list.
		assert.equal(catalogProviders().find((p) => p.id === "fake-plan")?.keyPresent, true);

		// Re-answering a finished session is a 409, not a crash.
		const again = answerLoginPrompt(sid, withPrompt.prompt!.id, "abc");
		assert.equal(again.ok, false);
	});

	it("reports a failed flow without leaking, and stores nothing", async () => {
		await logoutSubscription("fake-plan");
		const started = startLogin("fake-plan");
		assert.ok(started.ok);
		if (!started.ok) return;
		const s = await until(() => {
			const cur = getLoginSession(started.session.id);
			return cur?.prompt ? cur : null;
		}, "prompt");
		answerLoginPrompt(started.session.id, s.prompt!.id, "bad");
		const failed = await until(() => {
			const cur = getLoginSession(started.session.id);
			return cur && cur.status !== "running" ? cur : null;
		}, "failure");
		assert.equal(failed.status, "failed");
		assert.match(failed.error ?? "", /invalid_grant/);
		assert.equal(credentialStore.typeOf("fake-plan"), undefined);
	});

	it("cancel aborts a waiting flow and frees the provider for a fresh attempt", async () => {
		const first = startLogin("fake-plan");
		assert.ok(first.ok);
		if (!first.ok) return;
		await until(() => getLoginSession(first.session.id)?.prompt, "prompt");
		assert.equal(cancelLogin(first.session.id)?.status, "cancelled");

		// A second start supersedes any live flow for the same provider.
		const second = startLogin("fake-plan");
		const third = startLogin("fake-plan");
		assert.ok(second.ok && third.ok);
		if (second.ok) assert.equal(getLoginSession(second.session.id)?.status, "cancelled");
		if (third.ok) cancelLogin(third.session.id);
	});

	it("refuses providers without a subscription login", () => {
		const r = startLogin("groq");
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.status, 404);
	});

	it("a subscription provider is not connected, nor offered in the picker, until it has a stored login", async () => {
		assert.equal(catalogProviders().find((p) => p.id === "github-copilot")?.keyPresent, false);
		await credentialStore.modify("github-copilot", async () => credential("t"));
		assert.equal(catalogProviders().find((p) => p.id === "github-copilot")?.keyPresent, true);
		await logoutSubscription("github-copilot");
		assert.equal(catalogProviders().find((p) => p.id === "github-copilot")?.keyPresent, false);
	});

	it("logout removes only an OAuth credential", async () => {
		await credentialStore.modify("fake-plan", async () => credential("t"));
		assert.equal(await logoutSubscription("fake-plan"), true);
		assert.equal(credentialStore.typeOf("fake-plan"), undefined);
		await credentialStore.modify("some-custom", async () => ({ type: "api_key", key: "k" }));
		assert.equal(await logoutSubscription("some-custom"), false, "api keys are not subscriptions");
		assert.equal(credentialStore.typeOf("some-custom"), "api_key");
	});
});
