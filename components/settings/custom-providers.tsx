"use client";
/**
 * Custom (manual) APIs (custom-providers wave): add any model endpoint by
 * hand — Ollama, LM Studio, vLLM, LiteLLM, a corporate gateway — by picking
 * its wire protocol, base URL, optional key, and listing its models. Saved
 * through /api/providers; the key is write-only (never shown again — the row
 * says "key saved"). Saving/removing signals "keys" so the model picker and
 * the setup gate re-read the catalog.
 */

import { useEffect, useState } from "react";
import {
	CUSTOM_API_PROTOCOLS,
	CUSTOM_MODEL_DEFAULTS,
	slugifyProviderId,
	type CustomApiProtocol,
	type CustomAuthScheme,
	type CustomModelDef,
	type CustomProviderDef,
} from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useT } from "@/components/i18n";
import { inputDirection, textDirection } from "@/lib/i18n/direction";
import { localizeServerError } from "@/lib/i18n/server-errors";
import { toast } from "sonner";
import { SettingsGroup, ThinSelect } from "./controls.tsx";

interface ProviderView extends CustomProviderDef {
	hasKey: boolean;
}

interface DraftModel {
	id: string;
	name: string;
	reasoning: boolean;
	vision: boolean;
	contextWindow: string;
	maxTokens: string;
}

interface Draft {
	/** True while editing an existing provider (the id is its identity). */
	existing: boolean;
	id: string;
	/** The id follows the name until the user edits it by hand. */
	idTouched: boolean;
	name: string;
	api: CustomApiProtocol;
	baseUrl: string;
	authScheme: CustomAuthScheme;
	models: DraftModel[];
	/** Replacement key; empty = leave alone. */
	apiKey: string;
	clearKey: boolean;
	hasKey: boolean;
}

const blankModel = (): DraftModel => ({ id: "", name: "", reasoning: false, vision: false, contextWindow: "", maxTokens: "" });

function newDraft(): Draft {
	return {
		existing: false,
		id: "",
		idTouched: false,
		name: "",
		api: "openai-completions",
		baseUrl: "",
		authScheme: "default",
		models: [blankModel()],
		apiKey: "",
		clearKey: false,
		hasKey: false,
	};
}

function draftFrom(p: ProviderView): Draft {
	return {
		existing: true,
		id: p.id,
		idTouched: true,
		name: p.name,
		api: p.api,
		baseUrl: p.baseUrl,
		authScheme: p.authScheme,
		models: p.models.map((m) => ({
			id: m.id,
			name: m.name ?? "",
			reasoning: m.reasoning ?? false,
			vision: m.input?.includes("image") ?? false,
			contextWindow: m.contextWindow !== undefined ? String(m.contextWindow) : "",
			maxTokens: m.maxTokens !== undefined ? String(m.maxTokens) : "",
		})),
		apiKey: "",
		clearKey: false,
		hasKey: p.hasKey,
	};
}

/** The wire body for a draft. Blank optional fields are omitted so the
 *  server's defaults apply; numeric text is converted as-is (save() has
 *  already rejected non-numeric text). */
function draftToBody(d: Draft): { provider: CustomProviderDef; apiKey?: string | null } {
	const models: CustomModelDef[] = d.models
		.filter((m) => m.id.trim() !== "")
		.map((m) => {
			const out: CustomModelDef = { id: m.id.trim() };
			if (m.name.trim()) out.name = m.name.trim();
			if (m.reasoning) out.reasoning = true;
			if (m.vision) out.input = ["text", "image"];
			if (m.contextWindow.trim()) out.contextWindow = Number(m.contextWindow);
			if (m.maxTokens.trim()) out.maxTokens = Number(m.maxTokens);
			return out;
		});
	const body: { provider: CustomProviderDef; apiKey?: string | null } = {
		provider: { id: d.id.trim(), name: d.name.trim(), api: d.api, baseUrl: d.baseUrl.trim(), authScheme: d.authScheme, models },
	};
	if (d.apiKey.trim()) body.apiKey = d.apiKey.trim();
	else if (d.clearKey) body.apiKey = null;
	return body;
}

const inputClass =
	"h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const linkButton = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";
const mutedButton = "shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1">
			<span className="font-ui text-[11px] text-muted-foreground">{label}</span>
			{children}
		</label>
	);
}

function ProviderEditor({
	draft,
	setDraft,
	busy,
	error,
	onSave,
	onCancel,
	onDelete,
}: {
	draft: Draft;
	setDraft: (d: Draft) => void;
	busy: boolean;
	error: string | null;
	onSave: () => void;
	onCancel: () => void;
	onDelete?: () => void;
}) {
	const t = useT();
	const c = t.settings.customProviders;
	const shown = error ? localizeServerError(error, t) : null;
	const protocol = CUSTOM_API_PROTOCOLS.find((p) => p.id === draft.api);
	const patch = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
	const patchModel = (i: number, p: Partial<DraftModel>) =>
		patch({ models: draft.models.map((m, j) => (j === i ? { ...m, ...p } : m)) });
	return (
		<div className="flex flex-col gap-3 rounded-sm border border-border/60 px-2 py-2" data-testid="custom-provider-editor">
			<div className="grid grid-cols-2 gap-3">
				<Field label={c.name}>
					<input
						className={inputClass}
						value={draft.name}
						dir={inputDirection(draft.name)}
						placeholder={c.namePlaceholder}
						aria-label={c.nameAria}
						data-testid="custom-provider-name"
						disabled={busy}
						autoFocus
						onChange={(e) => patch({ name: e.target.value, ...(draft.idTouched ? {} : { id: slugifyProviderId(e.target.value) }) })}
					/>
				</Field>
				<Field label={c.id}>
					<input
						className={`${inputClass} disabled:opacity-60`}
						value={draft.id}
						dir="ltr"
						placeholder="local-ollama"
						aria-label={c.idAria}
						data-testid="custom-provider-id"
						disabled={busy || draft.existing}
						onChange={(e) => patch({ id: e.target.value, idTouched: true })}
					/>
				</Field>
				<Field label={c.protocol}>
					<ThinSelect value={draft.api} ariaLabel={c.protocolAria} testid="custom-provider-api" disabled={busy} onChange={(v) => patch({ api: v as CustomApiProtocol })}>
						{CUSTOM_API_PROTOCOLS.map((p) => (
							<option key={p.id} value={p.id} dir="ltr">
								{p.label}
							</option>
						))}
					</ThinSelect>
				</Field>
				<Field label={c.baseUrl}>
					<input
						className={inputClass}
						value={draft.baseUrl}
						dir="ltr"
						placeholder={protocol?.exampleBaseUrl}
						aria-label={c.baseUrl}
						data-testid="custom-provider-baseurl"
						disabled={busy}
						onChange={(e) => patch({ baseUrl: e.target.value })}
					/>
				</Field>
				<Field label={draft.hasKey && !draft.clearKey ? c.keySaved : c.keyOptional}>
					<input
						type="password"
						autoComplete="off"
						dir="ltr"
						className={inputClass}
						value={draft.apiKey}
						placeholder={draft.hasKey && !draft.clearKey ? "••••••••" : c.keylessPlaceholder}
						aria-label={c.keyAria}
						data-testid="custom-provider-key"
						disabled={busy}
						onChange={(e) => patch({ apiKey: e.target.value, clearKey: false })}
					/>
				</Field>
				<Field label={c.sendKeyAs}>
					<ThinSelect value={draft.authScheme} ariaLabel={c.authSchemeAria} testid="custom-provider-auth" disabled={busy} onChange={(v) => patch({ authScheme: v as CustomAuthScheme })}>
						<option value="default">{c.protocolDefault}</option>
						<option value="bearer">{c.bearer}</option>
					</ThinSelect>
				</Field>
			</div>
			{protocol && <p className="text-[11px] text-muted-foreground/70">{c.protocolHints[protocol.id]}</p>}
			{draft.hasKey && (
				<button type="button" className={`${mutedButton} self-start`} disabled={busy} onClick={() => patch({ clearKey: !draft.clearKey, apiKey: "" })}>
					{draft.clearKey ? c.keepKey : c.removeKey}
				</button>
			)}

			<div className="flex flex-col gap-1.5" data-testid="custom-provider-models">
				<span className="font-ui text-[11px] text-muted-foreground">{c.models}</span>
				{draft.models.map((m, i) => (
					<div key={i} className="flex flex-wrap items-center gap-2">
						<input className={`${inputClass} w-44`} dir="ltr" value={m.id} placeholder={c.modelIdPlaceholder} aria-label={c.modelIdAria(i + 1)} data-testid={`custom-model-${i}-id`} disabled={busy} onChange={(e) => patchModel(i, { id: e.target.value })} />
						<input className={`${inputClass} w-32`} dir={inputDirection(m.name)} value={m.name} placeholder={c.displayNamePlaceholder} aria-label={c.modelNameAria(i + 1)} disabled={busy} onChange={(e) => patchModel(i, { name: e.target.value })} />
						<input className={`${inputClass} w-24`} dir="ltr" value={m.contextWindow} inputMode="numeric" placeholder={c.ctxPlaceholder(CUSTOM_MODEL_DEFAULTS.contextWindow / 1000)} aria-label={c.modelCtxAria(i + 1)} disabled={busy} onChange={(e) => patchModel(i, { contextWindow: e.target.value })} />
						<input className={`${inputClass} w-24`} dir="ltr" value={m.maxTokens} inputMode="numeric" placeholder={c.maxPlaceholder(CUSTOM_MODEL_DEFAULTS.maxTokens / 1000)} aria-label={c.modelMaxAria(i + 1)} disabled={busy} onChange={(e) => patchModel(i, { maxTokens: e.target.value })} />
						<label className="flex items-center gap-1 text-[11px] text-muted-foreground">
							<input type="checkbox" checked={m.reasoning} disabled={busy} onChange={(e) => patchModel(i, { reasoning: e.target.checked })} />
							{c.reasoning}
						</label>
						<label className="flex items-center gap-1 text-[11px] text-muted-foreground">
							<input type="checkbox" checked={m.vision} disabled={busy} onChange={(e) => patchModel(i, { vision: e.target.checked })} />
							{c.images}
						</label>
						{draft.models.length > 1 && (
							<button type="button" className={mutedButton} disabled={busy} aria-label={c.removeModelAria(i + 1)} onClick={() => patch({ models: draft.models.filter((_, j) => j !== i) })}>
								✕
							</button>
						)}
					</div>
				))}
				<button type="button" className={`${mutedButton} self-start`} disabled={busy} onClick={() => patch({ models: [...draft.models, blankModel()] })}>
					{c.addModel}
				</button>
			</div>

			{shown && (
				<p role="alert" dir={textDirection(shown)} data-testid="custom-provider-error" className="text-xs text-danger">
					{shown}
				</p>
			)}
			<div className="flex items-center gap-3">
				<button type="button" className={linkButton} disabled={busy} onClick={onSave} data-testid="custom-provider-save">
					{t.common.actions.save}
				</button>
				<button type="button" className={mutedButton} disabled={busy} onClick={onCancel}>
					{t.common.actions.cancel}
				</button>
				{onDelete && (
					<button type="button" className={`${mutedButton} hover:text-danger`} disabled={busy} onClick={onDelete} data-testid="custom-provider-delete">
						{t.common.actions.delete}
					</button>
				)}
			</div>
		</div>
	);
}

export function CustomProvidersGroup() {
	const t = useT();
	const c = t.settings.customProviders;
	const [providers, setProviders] = useState<ProviderView[] | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = () =>
		fetch("/api/providers")
			.then((r) => r.json())
			.then((body: { providers?: ProviderView[] }) => setProviders(body.providers ?? []))
			.catch(() => setProviders([]));

	useEffect(() => {
		void reload();
	}, []);

	async function save() {
		if (!draft || busy) return;
		const badNumber = draft.models.find((m) => [m.contextWindow, m.maxTokens].some((v) => v.trim() !== "" && !/^\d+$/.test(v.trim())));
		if (badNumber) return setError(c.badNumber(badNumber.id || "?"));
		setBusy(true);
		setError(null);
		const res = await fetch("/api/providers", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(draftToBody(draft)),
		}).catch(() => null);
		setBusy(false);
		if (!res) return setError(c.unreachable);
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			return setError(body.error ?? c.saveFailed(res.status));
		}
		const name = draft.name.trim() || draft.id;
		setDraft(null);
		await reload();
		notifySettingsSaved("keys");
		toast.success(t.settings.toasts.providerSaved(name));
	}

	async function remove() {
		if (!draft || busy) return;
		setBusy(true);
		const res = await fetch(`/api/providers/${encodeURIComponent(draft.id)}`, { method: "DELETE" }).catch(() => undefined);
		const name = providers?.find((p) => p.id === draft.id)?.name ?? (draft.name.trim() || draft.id);
		setBusy(false);
		setDraft(null);
		await reload();
		notifySettingsSaved("keys");
		if (res?.ok) toast.success(t.settings.toasts.providerDeleted(name));
	}

	return (
		<SettingsGroup label={c.group} testid="group-custom-providers">
			{providers === null ? (
				<p className="px-1 py-1.5 text-xs text-muted-foreground/70">{t.common.states.loading}</p>
			) : (
				providers.map((p) => (
					<button
						key={p.id}
						type="button"
						data-testid={`custom-provider-${p.id}`}
						onClick={() => {
							setError(null);
							setDraft(draftFrom(p));
						}}
						className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-start transition-colors hover:bg-accent/50"
					>
						<span className="font-ui text-xs text-foreground" dir={textDirection(p.name)}>{p.name}</span>
						<span className="truncate font-mono text-[11px] text-muted-foreground">
							<bdi>{p.api}</bdi> · {c.modelCount(p.models.length)}
							{p.hasKey ? c.keySavedSuffix : ""}
						</span>
					</button>
				))
			)}
			{draft ? (
				<ProviderEditor
					draft={draft}
					setDraft={setDraft}
					busy={busy}
					error={error}
					onSave={() => void save()}
					onCancel={() => setDraft(null)}
					onDelete={draft.existing ? () => void remove() : undefined}
				/>
			) : (
				<button
					type="button"
					data-testid="custom-provider-add"
					onClick={() => {
						setError(null);
						setDraft(newDraft());
					}}
					className="w-full rounded-sm px-1 py-1.5 text-start font-ui text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
				>
					{c.add}
				</button>
			)}
		</SettingsGroup>
	);
}
