"use client";
/**
 * The Keys section (wave-5 polish, 2026-09-21 — owner design): a MINIMAL
 * key-value table. Provider left, masked key right, no description hints
 * (they took too much space), the "Get a key ↗" link a tiny muted guest.
 * Clicking a writable row unfolds a paste field + Save (+ Delete for a
 * file-sourced value) beneath it; Esc or a second click folds it away.
 * The Add-provider control is the LAST ROW of the table and uses the
 * app's shared dropdown look (ProviderMenuList — fuzzy search over the
 * 33 pi-ai providers).
 *
 * Owner rulings carried in:
 *  - Env-owned rows (a real environment variable owns the name — dev
 *    .env.local or launch env) render READ-ONLY + dimmed, no paste field:
 *    a paste box on a key the UI cannot make live would mislead.
 *  - OpenRouter is NOT special: one provider among 33, a row only when
 *    stored, otherwise it lives in the Add dropdown like everyone else.
 *  - Providers groups API keys, subscriptions, external CLI and custom
 *    APIs; Dictation and Search keys live in their own settings sections
 *    (dictation-section.tsx, search-section.tsx) over the same row
 *    component. Unknown variables stay masked/read-only at the end of
 *    Model API keys.
 *
 * API: GET /api/keys (masked statuses + the providers array), PUT
 * /api/keys/:id (shape-gated 400s land inline), DELETE. Saves take
 * effect immediately. Plaintext never returns from the store.
 */

import { useEffect, useRef, useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import {
	AUTH_KEYS,
	CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	CUSTOM_PROVIDER,
	normalizeBaseUrl,
	type AuthKeyStatus,
	type CustomModel,
	type CustomModelOverride,
	type KeyTestResult,
} from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { SubscriptionConnections } from "./subscription-connections.tsx";
import { ClaudeCodeInstallationStatus } from "./claude-code-status.tsx";
import { CustomProvidersGroup } from "./custom-providers.tsx";
import { SubscriptionsList } from "./subscriptions.tsx";
import { ProviderMenuList } from "./model-menu.tsx";
import { MenuShell } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useKeyStatuses, type KeyStatuses } from "./use-key-statuses.ts";
import { useT } from "@/components/i18n";
import type { Messages } from "@/lib/i18n/messages";
import { textDirection } from "@/lib/i18n/direction";
import { localizeServerError } from "@/lib/i18n/server-errors";
import { toast } from "sonner";

/** One pi-ai provider with plain API-key auth (the Platform seam —
 *  derived from pi-ai's own env-key table; no drift possible). */
export interface ProviderKeyInfo {
	id: string;
	envVar: string;
	label: string;
}

/** The custom endpoint's non-secret status (GET /api/custom-provider). */
interface CustomStatus {
	keyReuseRequired: boolean;
	revision: string;
	authMode: "keyless" | "apiKey";
	keySource: "env" | "file" | "none";
	baseUrl: string;
	models: CustomModel[];
	/** User pins by model id (context / max output / thinking). */
	overrides: Record<string, CustomModelOverride>;
	manualModels: string[];
	keyPresent: boolean;
}

async function readCustomStatus(inspectKey = false): Promise<CustomStatus> {
	const response = await fetch(`/api/custom-provider${inspectKey ? "?authMode=apiKey" : ""}`);
	if (!response.ok) throw new Error("Unable to load custom configuration.");
	const cp = await response.json() as Partial<CustomStatus>;
	return { keyReuseRequired: Boolean(cp.keyReuseRequired), revision: response.headers.get("etag") ?? "", authMode: cp.authMode ?? "keyless", keySource: cp.keySource ?? "none", baseUrl: cp.baseUrl ?? "", models: cp.models ?? [], overrides: cp.overrides ?? {}, manualModels: cp.manualModels ?? [], keyPresent: Boolean(cp.keyPresent) };
}

/** The curated tools group, pinned by id (the catalog owns the copy;
 *  these ids are the contract). Derived from the catalog (search wave,
 *  2026-09-20: the Google CSE pair retired, Tavily + Brave joined) — the
 *  section can never drift from core/auth-keys.ts again. */
const TOOL_IDS = AUTH_KEYS.map((k) => k.id) as readonly string[];

/** The custom endpoint's synthetic Add-provider entry (offered only while unconfigured). */
export const CUSTOM_PROVIDER_INFO: ProviderKeyInfo = {
	id: CUSTOM_PROVIDER.id,
	envVar: CUSTOM_PROVIDER.envVar,
	label: CUSTOM_PROVIDER.label,
};

/** The classification driving the table groups. Pure — exported for
 *  tests. OpenRouter is un-pinned (wave-5 owner ruling): no synthesis,
 *  no special row — it rides the same provider classification. */
export function classifyKeys(
	statuses: readonly AuthKeyStatus[],
	providers: readonly ProviderKeyInfo[] | undefined,
): {
	/** Stored provider keys (env or file), in GET order. */
	providerRows: AuthKeyStatus[];
	/** The curated tools rows (synthesized when absent — always shown,
	 *  they carry the docs links a first boot needs). */
	toolRows: AuthKeyStatus[];
	/** Unknown file vars — preserved, read-only. */
	unknownRows: AuthKeyStatus[];
	/** Providers without a stored key — the Add dropdown's options. */
	addable: ProviderKeyInfo[];
} {
	const byId = new Map(statuses.map((s) => [s.id, s]));
	const isTool = (id: string) => (TOOL_IDS as readonly string[]).includes(id);
	const providerEnv = new Set((providers ?? []).map((p) => p.envVar));
	const synth = (id: string): AuthKeyStatus => ({
		id,
		info: null,
		present: false,
		masked: null,
		source: "none",
		shadowedByEnv: false,
	});
	const providerRows: AuthKeyStatus[] = [];
	const unknownRows: AuthKeyStatus[] = [];
	for (const s of statuses) {
		if (isTool(s.id)) continue;
		// The custom endpoint's key has its OWN home (the Custom endpoint
		// section), so it never shows here — not as a provider row, not as an
		// "other stored variable".
		if (s.id === CUSTOM_PROVIDER.envVar) continue;
		if (providerEnv.has(s.id) || (!s.info && providers === undefined)) providerRows.push(s);
		else if (!s.info) unknownRows.push(s);
		// (pre-interlude catalogs: a curated-but-unclassified status still
		// renders as a provider row so nothing disappears)
		else providerRows.push(s);
	}
	return {
		providerRows,
		toolRows: TOOL_IDS.map((id) => byId.get(id) ?? synth(id)),
		unknownRows,
		addable: (providers ?? []).filter((p) => !byId.has(p.envVar)),
	};
}

/** A key row names its credential, not whichever provider sorts first.
 * Pi exposes Zen and Go separately but both read OPENCODE_API_KEY. */
export function providerKeyLabel(
	id: string,
	providers: readonly ProviderKeyInfo[] | undefined,
	openCodeLabel = "OpenCode (Zen / Go)",
): string | undefined {
	const matches = providers?.filter((p) => p.envVar === id);
	if (matches?.some((p) => p.id === "opencode") && matches.some((p) => p.id === "opencode-go")) return openCodeLabel;
	return matches?.[0]?.label;
}

/** The minimal status line, e.g. "…ab12 · 64" (tail · character count).
 *  Who owns the value (environment vs stored) is the badge's job. Pure. */
export function keyStatusLine(status: AuthKeyStatus, k: Messages["settings"]["keys"]): string {
	if (!status.present || !status.masked) return k.notSet;
	const tail = status.masked.replace(/ \((\d+) chars\)$/, "");
	const chars = status.masked.match(/\((\d+) chars\)$/)?.[1] ?? "?";
	return `${tail} · ${chars}`;
}

/** The state pill beside a key row: environment-owned, not set, connected /
 *  invalid (from a key test), or plainly saved. */
export function KeyStatusBadge({ status, test, testid }: { status: AuthKeyStatus; test?: KeyTestResult; testid: string }) {
	const k = useT().settings.keys;
	let text: string;
	let tone: string;
	if (status.source === "env") {
		text = k.statusEnv;
		tone = "bg-accent text-muted-foreground";
	} else if (!status.present) {
		text = k.notSet;
		tone = "text-muted-foreground";
	} else if (test?.status === "ok") {
		text = k.statusConnected;
		tone = "bg-success/15 text-success";
	} else if (test?.status === "invalid") {
		text = k.statusInvalid;
		tone = "bg-danger/15 text-danger";
	} else {
		text = k.statusKeySaved;
		tone = "bg-accent text-muted-foreground";
	}
	return (
		<span data-testid={`${testid}-badge`} className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
			{text}
		</span>
	);
}

/** The deep-linked row to unfold: seeded by `initialRow`, re-followed when
 *  it retargets while the section is open. */
export function useOpenRow(initialRow: string | undefined) {
	const state = useState<string | null>(initialRow ?? null);
	const setOpenRow = state[1];
	useEffect(() => {
		if (initialRow !== undefined) setOpenRow(initialRow);
	}, [initialRow, setOpenRow]);
	return state;
}

/** Escape folds any open editor WITHOUT closing the dialog. Claimed at
 *  document CAPTURE phase — the only stopPropagation that outruns both the
 *  input's React handler and the dialog's window-level listener. */
export function useFoldOnEscape(active: boolean, fold: () => void) {
	const foldRef = useRef(fold);
	useEffect(() => {
		foldRef.current = fold;
	});
	useEffect(() => {
		if (!active) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// A language dropdown above this editor in the dismissal stack owns
			// the first Escape; do not swallow it at document capture phase.
			if (document.querySelector('[data-testid="dictation-language-menu"]')) return;
			e.preventDefault();
			e.stopPropagation();
			foldRef.current();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [active]);
}

/** One table row: label left, tiny docs link + status right. Writable
 *  rows click-unfold an editor beneath (owner interaction); env-owned
 *  rows are dimmed and read-only (a paste box there would mislead). */
export function KeyTableRow({
	label,
	docsUrl,
	status,
	expanded,
	onToggle,
	onSave,
	onDelete,
	onCancel,
	testid,
	test,
	testing,
	onTest,
}: {
	label: string;
	/** The "Get a key ↗" target — curated keys carry one. */
	docsUrl?: string;
	status: AuthKeyStatus;
	expanded: boolean;
	onToggle: () => void;
	onSave: (value: string) => Promise<string | null>;
	onDelete?: () => Promise<void>;
	/** Folds the editor (owner, fix wave: the way OUT of a paste prompt
	 *  must be visible — Cancel beside Save/Delete, not only Esc). */
	onCancel: () => void;
	testid: string;
	/** The last key-test result (drives the badge). */
	test?: KeyTestResult;
	testing?: boolean;
	/** Provider rows only: runs POST /api/keys/:id/test. */
	onTest?: () => void;
}) {
	const t = useT();
	const k = t.settings.keys;
	const envOwned = status.source === "env";
	const [value, setValue] = useState("");
	const [reveal, setReveal] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const shown = error ? localizeServerError(error, t) : null;

	// The key hides again whenever the editor closes.
	useEffect(() => {
		if (!expanded) setReveal(false);
	}, [expanded]);

	async function save() {
		if (!value.trim() || busy) return;
		setBusy(true);
		setError(null);
		const err = await onSave(value);
		if (err) setError(err);
		else setValue("");
		setBusy(false);
	}

	// INLINE editing (owner, fix wave: "type the keys in line — more
	// table-like"): the expanded row becomes the editor itself — label
	// left, the paste field filling the middle, Save | Cancel (| Delete)
	// right — instead of a second line beneath the row.
	if (expanded && !envOwned) {
		return (
			<div data-testid={testid}>
				<div className="flex items-center gap-2 rounded-lg bg-accent/40 px-3 py-2" data-testid={`${testid}-editor`}>
					<span dir={textDirection(label)} className="shrink-0 font-ui text-sm text-foreground">{label}</span>
					<input
						type={reveal ? "text" : "password"}
						autoComplete="off"
						spellCheck={false}
						dir="ltr"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void save();
						}}
						placeholder={k.pastePlaceholder}
						aria-label={k.keyAria(label)}
						data-testid={`${testid}-input`}
						disabled={busy}
						autoFocus
						className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
					/>
					<button
						type="button"
						onClick={() => setReveal((v) => !v)}
						aria-label={reveal ? k.hideKey : k.showKey}
						aria-pressed={reveal}
						data-testid={`${testid}-reveal`}
						className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{reveal ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
					</button>
					<button
						type="button"
						onClick={() => void save()}
						disabled={busy || !value.trim()}
						data-testid={`${testid}-save`}
						className="shrink-0 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/60"
					>
						{t.common.actions.save}
					</button>
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						data-testid={`${testid}-cancel`}
						className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{t.common.actions.cancel}
					</button>
					{status.present && status.source === "file" && onDelete && (
						<button
							type="button"
							onClick={() => void onDelete()}
							disabled={busy}
							data-testid={`${testid}-delete`}
							className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{t.common.actions.delete}
						</button>
					)}
				</div>
				{shown && (
					<p role="alert" dir={textDirection(shown)} data-testid={`${testid}-error`} className="px-3 text-xs text-danger">
						{shown}
					</p>
				)}
			</div>
		);
	}

	return (
		<div data-testid={testid} className={envOwned ? "opacity-40" : undefined}>
			<div className="flex items-center gap-1">
				<button
					type="button"
					aria-expanded={expanded}
					data-testid={`${testid}-row`}
					onClick={() => !envOwned && onToggle()}
					className={`flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-3 py-2 text-start ${
						envOwned ? "cursor-default" : "cursor-pointer transition-colors hover:bg-accent/40"
					}`}
				>
					<span dir={textDirection(label)} className="font-ui text-sm text-foreground">{label}</span>
					<span className="flex items-center gap-2">
						{docsUrl && (
							<a
								href={docsUrl}
								target="_blank"
								rel="noreferrer"
								onClick={(e) => e.stopPropagation()}
								className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
							>
								{k.docsLink}
							</a>
						)}
						{status.present && status.masked && (
							<span data-testid={`${testid}-status`} dir="ltr" className="font-mono text-xs text-muted-foreground">
								{keyStatusLine(status, k)}
							</span>
						)}
						<KeyStatusBadge status={status} test={test} testid={testid} />
					</span>
				</button>
				{onTest && status.present && (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onTest();
						}}
						disabled={testing}
						data-testid={`${testid}-test`}
						className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground/40 disabled:hover:bg-transparent"
					>
						{testing ? k.testing : k.test}
					</button>
				)}
			</div>
			{shown && (
				<p role="alert" dir={textDirection(shown)} data-testid={`${testid}-error`} className="px-3 pb-1 text-xs text-danger">
					{shown}
				</p>
			)}
		</div>
	);
}

/** The Add-provider control — the table's last row, the app's shared
 *  dropdown look (portaled menu, the search + arrow-walk machine). */
function AddProviderRow({
	addable,
	onPick,
}: {
	addable: ProviderKeyInfo[];
	onPick: (p: ProviderKeyInfo) => void;
}) {
	const k = useT().settings.keys;
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (anchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div ref={anchorRef} className="relative">
			<button
				type="button"
				aria-expanded={open}
				data-testid="add-provider"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-start font-ui text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
			>
				<span>{k.addProvider}</span>
				{addable.length > 0 && <span className="font-mono text-xs">{addable.length}</span>}
			</button>
			{open && (
				<MenuShell
					anchorRef={anchorRef}
					testid="add-provider-menu"
					preferredSide="down"
					menuClass="flex w-72 flex-col rounded-xl border border-border bg-popover p-2 text-xs shadow-float"
				>
					{/* Close on pick (owner, fix wave): a chosen provider ends
					    the dropdown — the paste row is the next step. */}
					<ProviderMenuList
						providers={addable}
						onPick={(p) => {
							setOpen(false);
							onPick(p);
						}}
					/>
				</MenuShell>
			)}
		</div>
	);
}

/** The curated tool-key rows (Dictation and Search sections): the same
 *  KeyTableRow over statuses from the shared hook, one unfolded at a time. */
export function ToolKeyRows({
	statuses,
	ks,
	initialRow,
}: {
	statuses: readonly AuthKeyStatus[];
	ks: KeyStatuses;
	/** A deep-linked row to unfold on arrival (the dictation error's click
	 *  lands on DEEPGRAM_API_KEY). */
	initialRow?: string;
}) {
	const [openRow, setOpenRow] = useOpenRow(initialRow);
	useFoldOnEscape(openRow !== null, () => setOpenRow(null));
	return (
		<>
			{statuses.map((status) => {
				const label = status.info?.label ?? status.id;
				return (
					<KeyTableRow
						key={status.id}
						label={label}
						docsUrl={status.info?.docsUrl}
						status={status}
						expanded={openRow === status.id}
						onToggle={() => setOpenRow(openRow === status.id ? null : status.id)}
						onSave={async (v) => {
							const err = await ks.save(status.id, v, label);
							if (!err) setOpenRow(null);
							return err;
						}}
						onCancel={() => setOpenRow(null)}
						onDelete={() => ks.remove(status.id, label)}
						testid={`key-${status.id.toLowerCase()}`}
					/>
				);
			})}
		</>
	);
}

export function KeysSection({
	/** A deep-linked row to unfold on arrival (zero-keys wave). Followed
	 *  while mounted too — the settings dialog's while-open retarget
	 *  pattern. undefined = nothing seeded. */
	initialRow,
}: {
	initialRow?: string;
}) {
	const t = useT();
	const k = t.settings.keys;
	const ts = t.settings.toasts;
	const ks = useKeyStatuses();
	const { statuses, providers } = ks;
	/** The unfolded row (its id), null = all folded. Seeded by the
	 *  deep-link (initialRow) and re-followed when it retargets. */
	const [openRow, setOpenRow] = useOpenRow(initialRow);
	/** The paste editor for a freshly chosen Add-provider target. */
	const [adding, setAdding] = useState<ProviderKeyInfo | null>(null);
	const [addError, setAddError] = useState<string | null>(null);
	/** The custom endpoint's status + whether its connect editor is open. */
	const [custom, setCustom] = useState<CustomStatus | null>(null);
	const [addingCustom, setAddingCustom] = useState(false);
	/** Key-test results by env var, kept until the dialog unmounts. */
	const [tests, setTests] = useState<Record<string, KeyTestResult>>({});
	const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
	const [query, setQuery] = useState("");

	// Escape folds any open editor (unfolded row or the Add-provider paste)
	// WITHOUT closing the dialog.
	useFoldOnEscape(openRow !== null || adding !== null || addingCustom, () => {
		setOpenRow(null);
		setAdding(null);
		setAddingCustom(false);
	});

	// Best-effort and independent: the custom endpoint's status must never
	// blank the provider-key list if its fetch fails.
	const refreshCustom = async () => {
		try {
			setCustom(await readCustomStatus());
		} catch {
			/* custom status unavailable — leave it unset */
		}
	};
	const reload = async () => {
		await ks.reload();
		await refreshCustom();
	};

	useEffect(() => {
		void refreshCustom();
	}, []);

	const isProviderEnv = (id: string) => providers?.some((p) => p.envVar === id) ?? false;

	/** POST /api/keys/:id/test. `notify` = the manual Test button (a toast
	 *  with the verdict); false = the silent post-save test (badge only). */
	async function runTest(id: string, label: string, notify: boolean) {
		setTesting((prev) => new Set(prev).add(id));
		let result: KeyTestResult | null = null;
		try {
			const res = await fetch(`/api/keys/${id}/test`, { method: "POST" });
			if (res.ok) result = (await res.json()) as KeyTestResult;
		} catch {
			/* the app's own server was unreachable */
		}
		setTesting((prev) => {
			const next = new Set(prev);
			next.delete(id);
			return next;
		});
		if (result) {
			const settled = result;
			setTests((prev) => ({ ...prev, [id]: settled }));
		}
		if (!notify) return;
		const r: KeyTestResult = result ?? { status: "unreachable" };
		switch (r.status) {
			case "ok":
				toast.success(label, { description: k.testOk(r.latencyMs ?? 0, r.models) });
				break;
			case "invalid":
				toast.error(label, { description: k.testInvalid });
				break;
			case "http_error":
				toast.error(label, { description: k.testHttp(r.httpStatus ?? 0) });
				break;
			case "unreachable":
				toast.warning(label, { description: k.testUnreachable });
				break;
			case "unsupported":
				toast.info(label, { description: k.testUnsupported });
				break;
			case "no_key":
				toast.info(label, { description: k.testNoKey });
				break;
		}
	}

	async function saveKey(id: string, value: string, label: string): Promise<string | null> {
		const err = await ks.save(id, value, label);
		if (err) return err;
		void refreshCustom();
		if (isProviderEnv(id)) void runTest(id, label, false);
		return null;
	}

	async function deleteKey(id: string, label: string): Promise<void> {
		await ks.remove(id, label);
		setTests((prev) => {
			const { [id]: _dropped, ...rest } = prev;
			return rest;
		});
		void refreshCustom();
	}

	/** Forget the custom endpoint (config + key server-side), same rhythm as
	 *  deleteKey: fire, re-read, broadcast so the catalog narrows everywhere. */
	async function disconnectCustom(revision: string): Promise<string | null> {
		const res = await fetch("/api/custom-provider", { method: "DELETE", headers: { "content-type": "application/json", "if-match": revision }, body: JSON.stringify({}) }).catch(() => null);
		if (!res?.ok) return res ? ((await res.json().catch(() => ({}))).error ?? t.settings.customEndpoint.disconnectFailed) : t.settings.customEndpoint.disconnectNetwork;
		setAddingCustom(false);
		await reload();
		notifySettingsSaved("keys");
		toast.success(ts.disconnected(t.settings.customEndpoint.title));
		return null;
	}

	if (statuses === null) {
		return <p className="p-6 text-xs text-muted-foreground">{k.loading}</p>;
	}

	const { providerRows, unknownRows, addable } = classifyKeys(statuses, providers);

	async function saveNewProvider(p: ProviderKeyInfo, value: string) {
		const err = await saveKey(p.envVar, value, p.label);
		if (err) setAddError(err);
		else {
			setAdding(null);
			setAddError(null);
		}
	}

	const rowLabel = (status: AuthKeyStatus) => providerKeyLabel(status.id, providers, k.openCode) ?? status.info?.label ?? status.id;
	const needle = query.trim().toLowerCase();
	const matches = (label: string, envVar: string) =>
		needle === "" || label.toLowerCase().includes(needle) || envVar.toLowerCase().includes(needle);
	const shownRows = providerRows.filter((status) => matches(rowLabel(status), status.id));
	/** Unconfigured providers matching the query — rows that unfold the paste editor in place. */
	const searchHits = needle === "" ? [] : addable.filter((p) => matches(p.label, p.envVar));
	const onPickProvider = (p: ProviderKeyInfo) => {
		setAddError(null);
		if (p.id === CUSTOM_PROVIDER.id) {
			setAdding(null);
			setAddingCustom(true);
		} else {
			setAddingCustom(false);
			setAdding(p);
		}
	};
	const addingInResults = adding !== null && searchHits.some((p) => p.id === adding.id);

	return (
		<>
			<SettingsGroup label={k.modelKeys} testid="group-provider-keys">
				<input
					type="search"
					data-testid="provider-search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={t.settings.menus.searchProviders}
					aria-label={t.settings.menus.searchProviders}
					className="lh-input mb-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
				/>
				<div className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card/50 p-1">
				{shownRows.map((status) => {
					const label = rowLabel(status);
					return (
						<KeyTableRow
							key={status.id}
							label={label}
							docsUrl={status.info?.docsUrl}
							status={status}
							expanded={openRow === status.id}
							onToggle={() => setOpenRow(openRow === status.id ? null : status.id)}
							onSave={async (v) => {
								const err = await saveKey(status.id, v, label);
								if (!err) setOpenRow(null); // fold on success — rest state
								return err;
							}}
							onCancel={() => setOpenRow(null)}
							onDelete={() => deleteKey(status.id, label)}
							testid={`key-${status.id.toLowerCase()}`}
							test={tests[status.id]}
							testing={testing.has(status.id)}
							onTest={isProviderEnv(status.id) ? () => void runTest(status.id, label, true) : undefined}
						/>
					);
				})}
				{searchHits.map((p) => (
					<KeyTableRow
						key={p.id}
						label={p.label}
						status={{ id: p.envVar, info: null, present: false, masked: null, source: "none", shadowedByEnv: false }}
						expanded={adding?.id === p.id}
						onToggle={() => (adding?.id === p.id ? setAdding(null) : onPickProvider(p))}
						onSave={async (v) => {
							const err = await saveKey(p.envVar, v, p.label);
							if (!err) setAdding(null);
							return err;
						}}
						onCancel={() => setAdding(null)}
						testid={`key-${p.id}`}
					/>
				))}
				{needle !== "" && shownRows.length === 0 && searchHits.length === 0 && (
					<p className="px-3 py-2 text-xs text-muted-foreground">{t.settings.menus.noProviders}</p>
				)}
				{custom?.baseUrl && (
					<CustomEndpointRow
						status={custom}
						expanded={addingCustom}
						onToggle={() => setAddingCustom((v) => !v)}
					/>
				)}
				{addingCustom && (
					<CustomEndpointEditor
						revision0={custom?.revision ?? ""}
						authMode0={custom?.authMode ?? "keyless"}
						keySource0={custom?.keySource ?? "none"}
						keyReuseRequired0={custom?.keyReuseRequired ?? false}
						onReload={async () => { await reload(); setAddingCustom(false); }}
						baseUrl0={custom?.baseUrl ?? ""}
						keyPresent={custom?.keyPresent ?? false}
						models={custom?.models ?? []}
						overrides={custom?.overrides ?? {}}
						manualModels0={custom?.manualModels ?? []}
						onSaved={async () => {
							setAddingCustom(false);
							await reload();
							notifySettingsSaved("keys");
						}}
						onPinsSaved={async () => {
							await reload();
							notifySettingsSaved("keys");
						}}
						onDelete={disconnectCustom}
						onCancel={() => setAddingCustom(false)}
					/>
				)}
				{providers !== undefined && needle === "" && (
					<AddProviderRow
						addable={custom?.baseUrl ? addable : [...addable, CUSTOM_PROVIDER_INFO]}
						onPick={onPickProvider}
					/>
				)}
				{adding && !addingInResults && (
					<div className="flex items-center gap-2 rounded-lg px-3 py-2" data-testid={`key-${adding.id}-editor`}>
						<span dir={textDirection(adding.label)} className="shrink-0 font-ui text-sm text-foreground">{adding.label}</span>
						<AddProviderEditor provider={adding} onSave={(v) => void saveNewProvider(adding, v)} onCancel={() => setAdding(null)} error={addError} />
					</div>
				)}
				{unknownRows.length > 0 && <div data-testid="group-unknown-keys">
					{unknownRows.map((status) => <div key={status.id} data-testid={`unknown-${status.id}`} className="flex items-center justify-between gap-3 px-3 py-2 opacity-40">
						<span dir="ltr" className="font-mono text-xs text-foreground">{status.id}</span>
						<span className="font-mono text-xs text-muted-foreground" dir="ltr">{status.masked}</span>
					</div>)}
				</div>}
				<p data-testid="keys-privacy" className="px-3 py-2 text-xs text-muted-foreground">{k.privacy}</p>
				</div>
			</SettingsGroup>

			<SettingsGroup label={k.subscriptions} testid="group-subscriptions">
				<div className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card/50 p-1">
					<SubscriptionConnections />
					<SubscriptionsList />
				</div>
			</SettingsGroup>

			<SettingsGroup label={k.externalCli} testid="group-external-cli">
				<ClaudeCodeInstallationStatus />
			</SettingsGroup>

			<CustomProvidersGroup />
		</>
	);
}

/** The paste field for a provider chosen in the Add dropdown — rendered
 *  beneath the Add row until saved or cancelled. */
function AddProviderEditor({
	provider,
	onSave,
	onCancel,
	error,
}: {
	provider: ProviderKeyInfo;
	onSave: (value: string) => void;
	onCancel: () => void;
	error: string | null;
}) {
	const t = useT();
	const [value, setValue] = useState("");
	const shown = error ? localizeServerError(error, t) : null;
	return (
		<>
			<input
				type="text"
				dir="ltr"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && value.trim()) onSave(value);
				}}
				placeholder={t.settings.keys.pastePlaceholder}
				aria-label={t.settings.keys.keyAria(provider.label)}
				data-testid={`key-${provider.id}-input`}
				autoFocus
				className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<button
				type="button"
				onClick={() => value.trim() && onSave(value)}
				disabled={!value.trim()}
				data-testid={`key-${provider.id}-save`}
				className="shrink-0 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/60"
			>
				{t.common.actions.save}
			</button>
			<button
				type="button"
				onClick={onCancel}
				data-testid={`key-${provider.id}-cancel`}
				className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				{t.common.actions.cancel}
			</button>
			{shown && (
				<p role="alert" dir={textDirection(shown)} className="w-full ps-0 text-xs text-danger" data-testid={`key-${provider.id}-error`}>
					{shown}
				</p>
			)}
		</>
	);
}

/** One donor editor for first setup and Settings; setup omits offline pin and
 * disconnect controls, while authentication/revisions/manual IDs stay identical. */
export function CustomEndpointSetup({ onSaved }: { onSaved: () => void | Promise<void> }) {
	const t = useT();
	const ce = t.settings.customEndpoint;
	const [status, setStatus] = useState<CustomStatus | null>(null);
	const [error, setError] = useState(false);
	async function reload() {
		try { setStatus(await readCustomStatus()); setError(false); }
		catch { setError(true); }
	}
	useEffect(() => { void reload(); }, []);
	if (!status || error) return <div className="text-xs">{error ? ce.loadFailed : ce.loading}{error && <button onClick={() => void reload()}>{t.common.actions.retry}</button>}</div>;
	return <CustomEndpointEditor key={status.revision} setup revision0={status.revision} authMode0={status.authMode} keySource0={status.keySource} keyReuseRequired0={status.keyReuseRequired} baseUrl0={status.baseUrl} keyPresent={status.keyPresent} models={status.models} overrides={status.overrides} manualModels0={status.manualModels} onSaved={onSaved} onPinsSaved={reload} onReload={reload} onCancel={reload} />;
}

/** The custom endpoint's status row (shown once configured); clicking re-opens the editor. */
function CustomEndpointRow({
	status,
	expanded,
	onToggle,
}: {
	status: CustomStatus;
	expanded: boolean;
	onToggle: () => void;
}) {
	const ce = useT().settings.customEndpoint;
	const count = status.models.length;
	const line = ce.statusLine(status.baseUrl, count, status.authMode, status.keyPresent);
	return (
		<div data-testid="custom-endpoint-row">
			<button
				type="button"
				data-testid="custom-endpoint-row-btn"
				aria-expanded={expanded}
				onClick={onToggle}
				className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-start cursor-pointer transition-colors hover:bg-accent/40"
			>
				<span className="font-ui text-sm text-foreground">{ce.title}</span>
				<span data-testid="custom-endpoint-status" className="max-w-[60%] truncate font-mono text-xs text-muted-foreground">
					{line}
				</span>
			</button>
		</div>
	);
}

/** A pin row's raw input state — "" means "no pin": the endpoint's own value,
 *  then the compiled default, decides. `reasoning` is tri-state. */
interface PinDraft {
	context: string;
	maxTokens: string;
	reasoning: "" | "on" | "off";
}

const pinDraft = (pin: CustomModelOverride | undefined): PinDraft => ({
	context: pin?.context === undefined ? "" : String(pin.context),
	maxTokens: pin?.maxTokens === undefined ? "" : String(pin.maxTokens),
	reasoning: pin?.reasoning === undefined ? "" : pin.reasoning ? "on" : "off",
});

/** One draft row per discovered model, seeded from the stored pins. */
function draftsFor(
	models: readonly CustomModel[],
	overrides: Record<string, CustomModelOverride>,
): Record<string, PinDraft> {
	return Object.fromEntries(models.map((m) => [m.id, pinDraft(overrides[m.id])]));
}

/** Drafts → the PATCH payload (replace-whole): a blank field sends nothing and
 *  a fully blank model is absent — which IS the un-pin. */
function pinsPayload(drafts: Record<string, PinDraft>): Record<string, CustomModelOverride> {
	const out: Record<string, CustomModelOverride> = {};
	for (const [id, d] of Object.entries(drafts)) {
		const pin: CustomModelOverride = {};
		if (d.context.trim()) pin.context = Number(d.context);
		if (d.maxTokens.trim()) pin.maxTokens = Number(d.maxTokens);
		if (d.reasoning !== "") pin.reasoning = d.reasoning === "on";
		if (Object.keys(pin).length) Object.defineProperty(out, id, { value: pin, enumerable: true });
	}
	return out;
}

/** testids must survive ids carrying slashes, colons, dots. */
const pinTestid = (prefix: string, id: string) => `${prefix}-${id.replace(/[^a-z0-9-]/gi, "_")}`;

/** The custom endpoint's connect editor: base URL + key → POST /api/custom-provider
 *  (validate + discover + register), and the per-model limits form → PATCH (pins,
 *  no probe, so it works with the local server switched off). Image capability is
 *  detected automatically. */
function CustomEndpointEditor({
	setup = false,
	revision0, authMode0, keySource0, keyReuseRequired0, onReload,
	baseUrl0,
	keyPresent: initialKeyPresent,
	models,
	overrides,
	manualModels0,
	onSaved,
	onPinsSaved,
	onCancel,
	onDelete,
}: {
	setup?: boolean;
	revision0: string;
	authMode0: "keyless" | "apiKey";
	keySource0: "env" | "file" | "none";
	keyReuseRequired0: boolean;
	onReload: () => void | Promise<void>;
	baseUrl0: string;
	keyPresent: boolean;
	/** The discovered models — one limits row each. */
	models: readonly CustomModel[];
	/** Their stored user pins. */
	overrides: Record<string, CustomModelOverride>;
	manualModels0: readonly string[];
	onSaved: () => void | Promise<void>;
	/** Pins saved — the editor stays open (a form, not a connect). */
	onPinsSaved: () => void | Promise<void>;
	onCancel: () => void;
	onDelete?: (revision: string) => Promise<string | null>;
}) {
	const t = useT();
	const ce = t.settings.customEndpoint;
	const [revision, setRevision] = useState(revision0);
	const [authMode, setAuthMode] = useState(authMode0);
	const [keySource, setKeySource] = useState(keySource0);
	const [keyPresent, setKeyPresent] = useState(initialKeyPresent);
	const [keyReuseRequired, setKeyReuseRequired] = useState(keyReuseRequired0);
	const [authLoading, setAuthLoading] = useState(false);
	const [reuseKey, setReuseKey] = useState(false);
	useEffect(() => {
		if (authMode !== "apiKey") return;
		let cancelled = false;
		setAuthLoading(true);
		readCustomStatus(true).then((status) => {
			if (cancelled) return;
			setKeySource(status.keySource);
			setKeyPresent(status.keyPresent);
			setKeyReuseRequired(status.keyReuseRequired);
			if (status.keySource === "env") setKey("");
		}).catch(() => { if (!cancelled) setError(ce.inspectKeyFailed); })
			.finally(() => { if (!cancelled) setAuthLoading(false); });
		return () => { cancelled = true; };
	}, [authMode]);
	const [baseUrl, setBaseUrl] = useState(baseUrl0);
	const [key, setKey] = useState("");
	const [keyTouched, setKeyTouched] = useState(false);
	const [manualModels, setManualModels] = useState(manualModels0.join(", "));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The limits form: edited drafts over the stored pins, plus the last saved
	// payload as the dirty baseline (the server's echo is what gets stored).
	const [drafts, setDrafts] = useState<Record<string, PinDraft>>(() => draftsFor(models, overrides));
	const [baseline, setBaseline] = useState(() => JSON.stringify(pinsPayload(draftsFor(models, overrides))));
	const [pinsBusy, setPinsBusy] = useState(false);
	const [pinsError, setPinsError] = useState<string | null>(null);
	const changedTarget = normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(baseUrl0);
	const canConnect = Boolean(baseUrl.trim()) && (authMode === "keyless" || (!authLoading && ((Boolean(key.trim()) && keySource !== "env") || (keyPresent && (!(changedTarget || keyReuseRequired) || reuseKey)))));
	const shownError = error ? localizeServerError(error, t) : null;
	const shownPinsError = pinsError ? localizeServerError(pinsError, t) : null;

	const draftOf = (m: CustomModel): PinDraft => drafts[m.id] ?? pinDraft(overrides[m.id]);
	const setDraft = (m: CustomModel, patch: Partial<PinDraft>) =>
		setDrafts((prev) => ({ ...prev, [m.id]: { ...draftOf(m), ...patch } }));
	const current = Object.fromEntries(models.map((m) => [m.id, draftOf(m)])) as Record<string, PinDraft>;
	const dirty = JSON.stringify(pinsPayload(current)) !== baseline;

	async function savePins() {
		if (pinsBusy || busy || !dirty) return;
		setPinsBusy(true);
		setPinsError(null);
		const res = await fetch("/api/custom-provider", {
			method: "PATCH",
			headers: { "content-type": "application/json", "if-match": revision },
			body: JSON.stringify({ overrides: pinsPayload(current) }),
		}).catch(() => null);
		if (!res || !res.ok) {
			const b = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
			setPinsError(res ? (b?.error ?? t.settings.keys.saveFailed(res.status)) : ce.saveNetwork);
			setPinsBusy(false);
			return;
		}
		setRevision(res.headers.get("etag") ?? revision);
		// The server's stored map is the truth — echo it back.
		const body = (await res.json().catch(() => null)) as { overrides?: Record<string, CustomModelOverride> } | null;
		const next = draftsFor(models, body?.overrides ?? pinsPayload(current));
		setDrafts(next);
		setBaseline(JSON.stringify(pinsPayload(next)));
		await onPinsSaved();
		setPinsBusy(false);
	}

	async function save() {
		if (busy || pinsBusy || !canConnect) return;
		setBusy(true);
		setError(null);
		const res = await fetch("/api/custom-provider", {
			method: "POST",
			headers: { "content-type": "application/json", "if-match": revision },
			body: JSON.stringify({ baseUrl, authMode, reuseKey, manualModels, ...(authMode === "apiKey" && keyTouched && key.trim() && keySource !== "env" ? { key } : {}) }),
		}).catch(() => null);
		if (!res || !res.ok) {
			const b = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
			setError(res ? (b?.error ?? ce.connectFailed(res.status)) : ce.connectNetwork);
			setBusy(false);
			return;
		}
		toast.success(t.settings.toasts.connected(ce.title));
		await onSaved();
		setBusy(false);
	}

	return (
		<div data-testid="custom-endpoint-editor" className="flex flex-col gap-2 rounded-lg bg-accent/40 px-3 py-2">
			<div className="flex items-center gap-2">
				<span className="shrink-0 font-ui text-sm text-foreground">{ce.title}</span>
				<input
					type="text"
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder={ce.baseUrlPlaceholder}
					aria-label={ce.baseUrlAria}
					data-testid="custom-baseurl-input"
					disabled={busy}
					autoFocus
					className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
				/>
			</div>
			<input
				type="text"
				value={manualModels}
				onChange={(e) => setManualModels(e.target.value)}
				placeholder={ce.modelIdsPlaceholder}
				aria-label={ce.modelIdsAria}
				data-testid="custom-models-input"
				disabled={busy}
				className="h-8 min-w-0 rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<label className="flex items-center gap-2 text-xs">{ce.authentication}
				<select className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={ce.authenticationAria} data-testid="custom-auth-mode" value={authMode} disabled={busy || pinsBusy} onChange={(e) => { setAuthMode(e.target.value as "keyless" | "apiKey"); setReuseKey(false); }}>
					<option value="keyless">{ce.keyless}</option><option value="apiKey">{t.settings.customProviders.keyAria}</option>
				</select>
			</label>
			{authMode === "apiKey" && keySource === "env" && <p className="text-xs text-muted-foreground" data-testid="custom-env-owned">{ce.environmentKey}</p>}
			{authMode === "apiKey" && keyPresent && (changedTarget || keyReuseRequired) && <label className="text-xs"><input type="checkbox" data-testid="custom-reuse-key" checked={reuseKey} onChange={(e) => setReuseKey(e.target.checked)} />{ce.allowKeyReuse}</label>}
			<div className="flex items-center gap-2">
				{authMode === "apiKey" && <input
					type="password"
					value={key}
					onChange={(e) => {
						setKey(e.target.value);
						setKeyTouched(true);
						if (!e.target.value.trim()) setAuthMode("keyless");
					}}
					placeholder={keyPresent ? ce.keepKeyPlaceholder : t.settings.customProviders.keyAria}
					aria-label={ce.keyAria}
					data-testid="custom-key-input"
					disabled={busy || pinsBusy || keySource === "env"}
					className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
				/>}
				<button
					type="button"
					onClick={() => void save()}
					disabled={busy || pinsBusy || !canConnect}
					data-testid="custom-save"
					className="shrink-0 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/60"
				>
					{busy ? ce.connecting : t.common.actions.connect}
				</button>
				<button
					type="button"
					onClick={onCancel}
					disabled={busy}
					data-testid="custom-cancel"
					className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					{t.common.actions.cancel}
				</button>
				{/* Disconnect rides beside Connect, exactly the stored-key rows' Delete:
				    quiet text, one click, no confirm — and only once there IS an
				    endpoint (a fresh add has nothing to delete). */}
				{onDelete && baseUrl0.trim() && (
					<button
						type="button"
						onClick={async () => { setBusy(true); const err = await onDelete(revision); if (err) setError(err); setBusy(false); }}
						disabled={busy || pinsBusy}
						data-testid="custom-delete"
						className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{t.common.actions.disconnect}
					</button>
				)}
			</div>
			{!setup && models.length > 0 && (
				<div className="flex flex-col gap-1" data-testid="custom-pins">
					<div className="flex max-h-56 flex-col gap-1 overflow-y-auto pe-1">
						{models.map((m) => {
							const d = draftOf(m);
							return (
								<div key={m.id} className="flex items-center gap-2" data-testid={pinTestid("custom-pin-row", m.id)}>
									<span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={m.id}>
										{m.id}
										<span className="block text-xs text-muted-foreground">{ce.contextBefore}{d.context.trim() ? ce.userPin : m.context ? ce.reported(m.context) : ce.fallback(CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW)}{ce.outputBefore}{d.maxTokens.trim() ? ce.userPin : m.maxTokens ? ce.reported(m.maxTokens) : ce.fallback(CUSTOM_MODEL_DEFAULT_MAX_TOKENS)}</span>
									</span>
									<input
										type="text"
										inputMode="numeric"
										value={d.context}
										onChange={(e) => setDraft(m, { context: e.target.value })}
										placeholder={String(m.context ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW)}
										aria-label={ce.contextWindowAria(m.id)}
										data-testid={pinTestid("custom-pin-context", m.id)}
										disabled={pinsBusy}
										className="h-8 w-20 shrink-0 rounded-lg border border-input bg-background px-2 text-end font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
									/>
									<input
										type="text"
										inputMode="numeric"
										value={d.maxTokens}
										onChange={(e) => setDraft(m, { maxTokens: e.target.value })}
										placeholder={String(m.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS)}
										aria-label={ce.maxOutputAria(m.id)}
										data-testid={pinTestid("custom-pin-maxtokens", m.id)}
										disabled={pinsBusy}
										className="h-8 w-20 shrink-0 rounded-lg border border-input bg-background px-2 text-end font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
									/>
									<select
										value={d.reasoning}
										onChange={(e) => setDraft(m, { reasoning: e.target.value as PinDraft["reasoning"] })}
										aria-label={ce.reasoningSupportAria(m.id)}
										data-testid={pinTestid("custom-pin-reasoning", m.id)}
										disabled={pinsBusy}
										className="h-8 shrink-0 rounded-lg border border-input bg-background px-2 font-ui text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
									>
										<option value="">{ce.reasoningReported}</option>
										<option value="on">{ce.reasoningSupported}</option>
										<option value="off">{ce.reasoningUnsupported}</option>
									</select>
								</div>
							);
						})}
					</div>
					<div className="flex items-center gap-2">
						{shownPinsError && (
							<p role="alert" data-testid="custom-pins-error" className="text-xs text-danger">
								{shownPinsError}
							</p>
						)}
						<button
							type="button"
							onClick={() => void savePins()}
							disabled={pinsBusy || !dirty}
							data-testid="custom-pins-save"
							className="ms-auto shrink-0 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/60"
						>
							{pinsBusy ? t.common.states.saving : ce.saveLimits}
						</button>
					</div>
				</div>
			)}
			<div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="custom-help">
				{!setup && models.length > 0 && <p data-testid="custom-budget-help">{ce.budgetHelp}</p>}
				<p data-testid="custom-reasoning-help">{ce.reasoningHelp}</p>
			</div>
			{(error || pinsError) && <button type="button" data-testid="custom-reload" onClick={() => void onReload()} className="text-start text-xs text-brand underline-offset-2 hover:underline">{ce.reload}</button>}
			{shownError && (
				<p role="alert" data-testid="custom-error" className="text-xs text-danger">
					{shownError}
				</p>
			)}
		</div>
	);
}
