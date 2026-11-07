"use client";
/**
 * AI subscriptions (subscriptions wave): sign in with a paid plan (Claude
 * Pro/Max, GitHub Copilot, ChatGPT/Codex, Gemini CLI, Antigravity …)
 * instead of pasting an API key. The provider-owned OAuth flow is relayed
 * through a polled login session (/api/subscriptions/sessions/:sid): the
 * panel shows the sign-in link or device code, asks the flow's questions
 * (e.g. "paste the redirect URL"), and reports the outcome. Finishing or
 * disconnecting signals "keys" so the picker and setup gate re-read the
 * catalog.
 */

import { useEffect, useRef, useState } from "react";
import type { LoginEvent, LoginSessionView, SubscriptionProviderInfo } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useT } from "@/components/i18n";
import { textDirection } from "@/lib/i18n/direction";

const POLL_MS = 1000;

const linkButton = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";
const mutedButton = "shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline";

/** The latest event of a kind (the UI shows the freshest url/code). */
function latest<T extends LoginEvent["type"]>(events: LoginEvent[], type: T): Extract<LoginEvent, { type: T }> | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e && e.type === type) return e as Extract<LoginEvent, { type: T }>;
	}
	return undefined;
}

function LoginPanel({ session, onAnswer, onCancel }: { session: LoginSessionView; onAnswer: (promptId: string, value: string) => Promise<void>; onCancel: () => void }) {
	const t = useT();
	const s = t.settings.subscriptions;
	const [value, setValue] = useState("");
	const [sending, setSending] = useState(false);
	const url = latest(session.events, "auth_url");
	const device = latest(session.events, "device_code");
	const note = latest(session.events, "progress") ?? latest(session.events, "info");
	const prompt = session.prompt;

	async function send(answer: string) {
		if (!prompt || sending) return;
		setSending(true);
		await onAnswer(prompt.id, answer);
		setValue("");
		setSending(false);
	}

	return (
		<div className="flex flex-col gap-2 rounded-sm border border-border/60 px-2 py-2" data-testid="subscription-login-panel">
			{url && (
				<p className="text-xs text-foreground">
					<a href={url.url} target="_blank" rel="noreferrer" className="underline underline-offset-2" data-testid="subscription-auth-link">
						{s.openSignIn}
					</a>
					{url.instructions && <span dir={textDirection(url.instructions)} className="ms-2 text-muted-foreground">{url.instructions}</span>}
				</p>
			)}
			{device && (
				<p className="text-xs text-foreground">
					{s.enterCodeBefore}<span className="font-mono text-sm" dir="ltr" data-testid="subscription-device-code">{device.userCode}</span>{s.enterCodeMiddle}
					<a href={device.verificationUri} target="_blank" rel="noreferrer" dir="ltr" className="underline underline-offset-2">
						{device.verificationUri} ↗
					</a>{s.enterCodeAfter}
				</p>
			)}
			{note && <p dir={textDirection(note.message)} className="text-[11px] text-muted-foreground lh-align-page">{note.message}</p>}
			{prompt &&
				(prompt.type === "select" ? (
					<div className="flex flex-col gap-1" data-testid="subscription-prompt">
						<span dir={textDirection(prompt.message)} className="text-xs text-foreground lh-align-page">{prompt.message}</span>
						{prompt.options?.map((o) => (
							<button key={o.id} type="button" dir={textDirection(o.label)} disabled={sending} className={`${linkButton} self-start`} onClick={() => void send(o.id)}>
								{o.label}
							</button>
						))}
					</div>
				) : (
					<div className="flex flex-col gap-1" data-testid="subscription-prompt">
						<span dir={textDirection(prompt.message)} className="text-xs text-foreground lh-align-page">{prompt.message}</span>
						<div className="flex items-center gap-2">
							<input
								type={prompt.type === "secret" ? "password" : "text"}
								dir="ltr"
								value={value}
								placeholder={prompt.placeholder ?? (prompt.type === "manual_code" ? s.pasteRedirect : "")}
								aria-label={prompt.message}
								data-testid="subscription-prompt-input"
								disabled={sending}
								onChange={(e) => setValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && value.trim()) void send(value.trim());
								}}
								className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
							/>
							<button type="button" className={linkButton} disabled={sending || !value.trim()} onClick={() => void send(value.trim())} data-testid="subscription-prompt-send">
								{s.submit}
							</button>
						</div>
					</div>
				))}
			{!url && !device && !prompt && !note && <p className="text-[11px] text-muted-foreground">{s.starting}</p>}
			<button type="button" className={`${mutedButton} self-start`} onClick={onCancel} data-testid="subscription-login-cancel">
				{t.common.actions.cancel}
			</button>
		</div>
	);
}

export function SubscriptionsList() {
	const t = useT();
	const s = t.settings.subscriptions;
	const [providers, setProviders] = useState<SubscriptionProviderInfo[] | null>(null);
	const [session, setSession] = useState<LoginSessionView | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** The auth URL already auto-opened for this session (never re-open on each poll). */
	const opened = useRef<string | null>(null);
	/** Provider whose login request is in flight (the POST can take a while on a cold server); shows "Signing in…" instantly. */
	const [starting, setStarting] = useState<string | null>(null);

	const reload = () =>
		fetch("/api/subscriptions/providers")
			.then((r) => r.json())
			.then((body: { providers?: SubscriptionProviderInfo[] }) => setProviders(body.providers ?? []))
			.catch(() => setProviders([]));

	useEffect(() => {
		void reload();
	}, []);

	const sessionId = session?.id;
	const running = session?.status === "running";
	// Poll the login session until it settles.
	useEffect(() => {
		if (!sessionId || !running) return;
		let stopped = false;
		let inFlight = false;
		// A poll that cannot be answered means the login is unrecoverable from here:
		// free the server's callback port and say so instead of spinning forever.
		const fail = (message: string) => {
			stopped = true;
			void fetch(`/api/subscriptions/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
			setSession(null);
			setError(message);
		};
		const tick = async () => {
			if (stopped || inFlight) return;
			inFlight = true;
			try {
				const res = await fetch(`/api/subscriptions/sessions/${sessionId}`).catch(() => null);
				if (stopped) return;
				if (!res) return fail(s.unreachable);
				if (!res.ok) {
					const failure = (await res.json().catch(() => ({}))) as { error?: string };
					if (stopped) return;
					return fail(failure.error ?? s.statusCheckFailed(res.status));
				}
				const body = (await res.json()) as { session: LoginSessionView };
				if (stopped) return;
				setSession(body.session);
				if (body.session.status !== "running") {
					if (body.session.status === "failed") setError(body.session.error ?? s.signInFailed);
					await reload();
					if (body.session.status === "succeeded") notifySettingsSaved("keys");
				}
			} finally {
				inFlight = false;
			}
		};
		const timer = setInterval(() => void tick(), POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [sessionId, running, s]);

	// Open the sign-in page once per URL (the flow's own callback server
	// finishes the login when the user returns).
	const authUrl = session ? latest(session.events, "auth_url")?.url : undefined;
	useEffect(() => {
		if (!authUrl || opened.current === authUrl) return;
		opened.current = authUrl;
		window.open(authUrl, "_blank", "noopener,noreferrer");
	}, [authUrl]);

	async function connect(id: string) {
		setError(null);
		opened.current = null;
		setStarting(id);
		try {
			const res = await fetch(`/api/subscriptions/${encodeURIComponent(id)}/login`, { method: "POST" }).catch(() => null);
			if (!res) return setError(s.unreachable);
			const body = (await res.json().catch(() => ({}))) as { session?: LoginSessionView; error?: string };
			if (!res.ok || !body.session) return setError(body.error ?? s.startFailed(res.status));
			setSession(body.session);
		} finally {
			setStarting(null);
		}
	}

	async function answer(promptId: string, value: string) {
		if (!session) return;
		const res = await fetch(`/api/subscriptions/sessions/${session.id}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ promptId, value }),
		}).catch(() => null);
		if (res && !res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setError(body.error ?? s.answerFailed);
		}
	}

	async function cancel() {
		if (!session) return;
		await fetch(`/api/subscriptions/sessions/${session.id}`, { method: "DELETE" }).catch(() => undefined);
		setSession(null);
		await reload();
	}

	async function disconnect(id: string) {
		await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
		await reload();
		notifySettingsSaved("keys");
	}

	if (providers === null) return <p className="px-1 py-1.5 text-xs text-muted-foreground/70">{t.common.states.loading}</p>;
	return (
		<div data-testid="subscriptions-list" className="flex flex-col">
			{providers.map((p) => {
				const active = starting === p.id || (session?.providerId === p.id && session.status === "running");
				return (
					<div key={p.id} data-testid={`subscription-${p.id}`} className="flex flex-col gap-1.5">
						<div className="flex items-center justify-between gap-3 px-1 py-1.5">
							<span className="flex min-w-0 flex-col">
								<span dir={textDirection(p.name)} className="font-ui text-xs text-foreground lh-align-page">{p.name}</span>
								{p.caveat && <span dir={textDirection(p.caveat)} className="text-[10px] text-muted-foreground/70 lh-align-page">{p.caveat}</span>}
							</span>
							<span className="flex shrink-0 items-center gap-3">
								<span className="font-mono text-[11px] text-muted-foreground">{p.connected ? s.connected : ""}</span>
								{p.connected ? (
									<button type="button" className={`${mutedButton} hover:text-danger`} onClick={() => void disconnect(p.id)} data-testid={`subscription-${p.id}-disconnect`}>
										{t.common.actions.disconnect}
									</button>
								) : (
									<button type="button" className={linkButton} disabled={active} onClick={() => void connect(p.id)} data-testid={`subscription-${p.id}-connect`}>
										{active ? s.signingIn : t.common.actions.connect}
									</button>
								)}
							</span>
						</div>
						{starting === p.id && <p className="px-2 pb-1 text-[11px] text-muted-foreground" data-testid="subscription-login-starting">{s.starting}</p>}
						{starting !== p.id && active && session && <LoginPanel session={session} onAnswer={answer} onCancel={() => void cancel()} />}
					</div>
				);
			})}
			{error && (
				<p role="alert" dir={textDirection(error)} data-testid="subscriptions-error" className="px-1 py-1 text-xs text-danger">
					{error}
				</p>
			)}
		</div>
	);
}

