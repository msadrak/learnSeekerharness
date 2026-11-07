"use client";
/**
 * The Agent section (settings-app wave): the THREE MODEL SLOTS, the tool
 * toggles, and the prompt override
 * switches — three GROUPS (owner, 2026-09-20: clear separation — Models /
 * Tools / System prompts).
 *
 * Model slots (model-slots wave, 2026-09-20): Strong = Prober + Teacher, Cheap
 * = the five workhorse roles, Vision = Visual maker + PDF reader. Each
 * slot row carries the shared dropdown (fuzzy search, arrow-walk, Enter
 * pick — ModelMenuList/ThinkingMenuList from ./model-menu.tsx) over the
 * FEDERATED catalog (/api/models serves only keyed providers, fresh per
 * call — saving a key in Keys immediately widens this picker). The
 * vision slot filters to image-capable models (Model.input). The slots
 * live in the `models` settings section (PUT /api/settings/models — slot
 * pins are engine-level, not per-chat); the rest of the section writes
 * the `agent` section as before. Resolution per tier: slot override →
 * factory pin (GET /api/models' `slots` — resolved, cannot drift from
 * what runs). The Default row clears the slot override; a stored id stays
 * VISIBLE even when its provider's key lapsed out of the catalog — a
 * trigger showing "Default" over a live override would lie about the
 * record.
 *
 * Per-role overrides: under the Cheap and Vision slot rows a collapsed
 * disclosure lists each background role of that tier (agent.models[role]);
 * a role without an override reads "Same as tier". The strong tier has
 * none — prober/teacher are chat-controlled.
 *
 * Tools — the owner's final list (2026-09-19): research, demo, visual, pdf.
 * Absent key = enabled in the schema; the UI writes explicit booleans for
 * all four (simpler to reason about, sanitize-equivalent).
 *
 * Prompts: GET /api/settings/prompts segments — Teacher, Prober, Practice,
 * then Shared LAST. The server returns each agent's actual segments,
 * including its shared subset; sectionedSegments deduplicates shared
 * chunks and derives per-fragment usage from membership in those lists.
 * The row rulings: only the TOGGLE
 * grays when there's no override file (the file name is always
 * full-contrast); NO description line when there's no override (the empty
 * state is clean — toggle + name); the indicator ("Your version is
 * saved") appears ONLY when an override exists. The switch requires an
 * override FILE (route-enforced), so a file-less toggle is disabled.
 * The segments view re-reads on the 'lh:settings-saved' signal for the
 * agent section — the view's enabled flags derive from the record's
 * switches, and the 2026-09-26 state-echo bug was exactly this reader
 * missing (the toggle painted its old state until a remount re-fetched).
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { CacheRetention } from "@earendil-works/pi-ai";
import { CacheRetentionMenu, cacheRetentionLabel } from "./cache-retention-menu.tsx";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsSaved } from "@/components/settings-signal";
import { defaultOrderLevel, populateLevel } from "@/components/thinking-default";
import { useModelCatalog } from "@/components/model-catalog";
import { Hint } from "@/components/ui/hint";
import type React from "react";
import { ChevronRightIcon } from "lucide-react";
import {
	COMPACTION_THRESHOLD_FLOOR,
	MODEL_SLOTS,
	BACKGROUND_MODEL_ROLES,
	ROLE_SLOT,
	resolveSettings,
	isFileAccessFolder,
	type AgentSettings,
	type BackgroundModelRole,
	type CompactionSettings,
	type GraphSettings,
	type ModelSlotName,
	type ModelsSettings,
	type SearchEngineId,
} from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, SettingsMenuTrigger, Toggle, CommitInput } from "./controls.tsx";
import { ModelMenuList, ThinkingMenuList } from "./model-menu";
import { ChatGPTBackgroundAccess } from "./chatgpt-connection";
import { NativeSubscriptionBackgroundAccess } from "./subscription-connections";
import { useT } from "@/components/i18n";
import { en, type Messages } from "@/lib/i18n/messages";
import { textDirection } from "@/lib/i18n/direction";
import { localizeServerError } from "@/lib/i18n/server-errors";

/** The owner's final toggleable-tool list (confirm with the user before
 *  changing — the Teacher stream settled this 2026-09-19). */
export const TOGGLE_TOOLS = ["research", "demo", "visual", "pdf"] as const;

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** SegmentInfo as GET /api/settings/prompts returns it. */
interface SegmentInfo {
	path: string;
	sourceText: string;
	overrideText: string | null;
	enabled: boolean;
	shared: boolean;
}

type PromptView = Record<"teacher" | "prober" | "practice", SegmentInfo[]>;
type PromptRow = SegmentInfo & { usageHint?: string };

/** Compose: one tool toggled, the rest of the section carried verbatim.
 *  Pure — exported for tests. */
export function composeTool(agent: AgentSettings | undefined, id: string, on: boolean): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, [id]: on } };
}

/** A file-access folder entry the server will accept: absolute (POSIX or
 *  Windows drive/UNC) or "~"-anchored. Pure — exported for tests. */
export function isFolderEntry(folder: string): boolean { return isFileAccessFolder(folder); }

/** The switch changes ONLY restriction, never discards saved folders. */
export function composeFileRestriction(agent: AgentSettings | undefined, restricted: boolean): AgentSettings {
	return { ...agent, fileAccess: { restricted, folders: agent?.fileAccess?.folders ?? [] } };
}

/** Compose: add one allowed folder (trimmed; duplicates and invalid entries
 *  are no-ops). Pure — exported for tests. */
export function composeAddFolder(agent: AgentSettings | undefined, folder: string): AgentSettings {
	const next = folder.trim();
	const folders = agent?.fileAccess?.folders ?? [];
	const restricted = agent?.fileAccess?.restricted ?? false;
	if (!isFolderEntry(next) || folders.includes(next)) return { ...agent, fileAccess: { restricted, folders } };
	return { ...agent, fileAccess: { restricted, folders: [...folders, next] } };
}

/** Removing the last folder NEVER changes the restriction switch. */
export function composeRemoveFolder(agent: AgentSettings | undefined, folder: string): AgentSettings {
	return { ...agent, fileAccess: { restricted: agent?.fileAccess?.restricted ?? false, folders: (agent?.fileAccess?.folders ?? []).filter((f) => f !== folder) } };
}

/** The quizzing mechanics (owner 2026-09-27): a segmented control, not a
 *  toggle — exactly one mechanic is ever active. `explain: true` arms
 *  free-recall (explain in, quiz out); anything else is multiple choice.
 *  `quiz` itself is never written (mechanics-managed — see quizMechanics
 *  in agent/tools.ts). Pure — exported for tests. */
export function composeQuizMechanics(agent: AgentSettings | undefined, mechanics: "choice" | "free"): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, explain: mechanics === "free" } };
}

/** Compose the prober graph-tools toggle (wave 7): its own key in the
 *  agent section — never in the tool-toggles map (owner ruling). Absent =
 *  ON (the toggle discipline); the write is explicit either way, so an
 *  explicit-off record stays visible as stored. Pure — exported for tests. */
export function composeGraphTools(agent: AgentSettings | undefined, on: boolean): AgentSettings {
	return { ...agent, graphTools: { enabled: on } };
}

/** Compose: one slot's model/thinking override. Empty model = absent
 *  override (Default — falls to the factory pin); empty thinking = the
 *  tier keeps its resolved thinking budget. Per-field independence, same
 *  as the schema's ModelSlot. Pure — exported for tests. */
export function composeSlotModel(
	models: ModelsSettings | undefined,
	slot: ModelSlotName,
	provider: string,
	id: string,
	thinking: string,
): ModelsSettings {
	const prev = models?.[slot];
	const next = { ...models };
	if (!provider && !id && !thinking) {
		delete next[slot];
		return next;
	}
	next[slot] = {
		...(prev?.cacheRetention !== undefined ? { cacheRetention: prev.cacheRetention } : {}),
		...(provider && id ? { model: { provider, id } } : prev?.model ? { model: prev.model } : {}),
		...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
	};
	return next;
}

/** Retention is slot-only; selecting Pi default removes the field entirely. */
export function composeSlotCacheRetention(models: ModelsSettings | undefined, slot: ModelSlotName, value: CacheRetention | undefined): ModelsSettings {
	const next = { ...models?.[slot] };
	if (value === undefined) delete next.cacheRetention;
	else next.cacheRetention = value;
	return { ...models, [slot]: next };
}

/** Compose: the search-engine preference. null = the explicit pin is
 *  REMOVED (auto-activation takes over — the schema's resting state).
 *  Pure — exported for tests. */
export function composeSearchEngine(
	agent: AgentSettings | undefined,
	engine: SearchEngineId | null,
): AgentSettings {
	if (engine === null) {
		if (!agent?.search) return { ...agent };
		const { search: _drop, ...rest } = agent;
		return { ...rest } as AgentSettings;
	}
	return { ...agent, search: { engine } };
}

/** Compose: one background role's model override. null REMOVES the model
 *  (and `models` itself once empty); a pick keeps the role's thinking level.
 *  Pure — exported for tests. */
export function composeRoleModel(
	agent: AgentSettings | undefined,
	role: BackgroundModelRole,
	model: { provider: string; id: string } | null,
): AgentSettings {
	const models = { ...agent?.models };
	const next: AgentSettings = { ...agent };
	if (model === null) delete models[role];
	else models[role] = { ...models[role], model };
	if (Object.keys(models).length === 0) delete next.models;
	else next.models = models;
	return next;
}

/** The indicator under a row whose override IS the version in use (owner
 *  ruling, refined 2026-09-26: the small text states WHICH VERSION IS
 *  IN USE — "Your version is in use" when the switch is on, and NOTHING
 *  when the default composes, even if a saved override sits on disk
 *  unused. The switch's meaning becomes legible: it visibly controls
 *  this line). Exported for the pin. */
export const PROMPT_IN_USE_HINT = en.settings.agent.promptInUse;

/** Prompt sections in display order; Shared is deduplicated and last. */
export interface PromptSection {
	id: keyof PromptView | "shared";
	label: string;
	segments: PromptRow[];
}

/** Keep each agent's own assembly order, then list shared chunks once.
 *  Usage is derived from the API's actual per-agent membership, never a
 *  second copy of the runtime's Practice shared-fragment allowlist.
 *  Pure — exported for tests. */
export function sectionedSegments(view: PromptView, a: Messages["settings"]["agent"] = en.settings.agent): PromptSection[] {
	const agents = [
		{ id: "teacher", label: a.sections.teacher },
		{ id: "prober", label: a.sections.prober },
		{ id: "practice", label: a.sections.practice },
	] as const;
	const shared = new Map<string, SegmentInfo>();
	for (const { id } of agents) {
		for (const segment of view[id]) {
			if (segment.shared && !shared.has(segment.path)) shared.set(segment.path, segment);
		}
	}
	return [
		...agents.map(({ id, label }) => ({ id, label, segments: view[id].filter((s) => !s.shared) })),
		{
			id: "shared",
			label: a.sections.shared,
			segments: [...shared.values()].map((segment) => {
				const users = agents.filter(({ id }) => view[id].some((s) => s.path === segment.path)).map(({ label }) => label);
				const usage = users.length > 1 ? a.userList(users) : users[0];
				return { ...segment, usageHint: a.usedBy(usage!) };
			}),
		},
	];
}

/** Compose: one prompt switch. on = explicit true; off = key REMOVED
 *  (absent = off is the schema's resting state; explicit false is the
 *  same thing but noisier). Pure — tests. */
export function composePromptSwitch(agent: AgentSettings | undefined, path: string, on: boolean): AgentSettings {
	const prompts = { ...agent?.prompts };
	if (on) prompts[path] = true;
	else delete prompts[path];
	return { ...agent, prompts };
}

/** The collapsed select look (owner: "the look of the collapsed menu is
 *  good") — now a button that opens the shared model-picker dropdown. */
export function MenuTrigger({
	value,
	emptyLabel,
	ariaLabel,
	testid,
	open,
	onClick,
	widthClass,
	disabled,
	hint,
}: {
	value: string;
	hint?: string;
	/** What the trigger shows when there is no override ("Default"). */
	emptyLabel: string;
	ariaLabel: string;
	testid: string;
	open: boolean;
	onClick: () => void;
	/** Owner (2026-09-20): the thinking trigger is FIXED at the width the
	 *  Default state needs (values shifting it mid-edit shifted the row);
	 *  the model trigger takes the same width as a MINIMUM — its values
	 *  genuinely vary in length. */
	widthClass: string;
	/** The no-key search state grays the whole row; the trigger follows. */
	disabled?: boolean;
}) {
	const button = (
		<SettingsMenuTrigger
			value={value || emptyLabel}
			aria-label={ariaLabel}
			aria-expanded={open}
			data-testid={testid}
			onClick={() => {
				if (!disabled) onClick();
			}}
			unavailable={disabled}
			className={widthClass}
		/>
	);
	return hint ? <Hint label={hint}>{button}</Hint> : button;
}

/* The section's dropdowns all mount the shared MenuShell (fix wave chunk
 * B): portaled to document.body, fixed-anchored to the open trigger by
 * testid (the section's one-ref pattern), opening DOWN with the shell's
 * viewport cap and auto-flip. data-lh-menu rides the shell — the
 * outside-click contract's exemption mark. */

export function AgentSection({
	agent,
	fileAccessError,
	models,
	graph,
	compaction,
	onSectionChange,
	onModelsChange,
	onCompactionChange,
}: {
	agent: AgentSettings | undefined;
	fileAccessError?: string | null;
	/** The `models` section (slot pins — engine-level, PUT /api/settings/models). */
	models: ModelsSettings | undefined;
	/** The `graph` section — READ ONLY here: the graphTools row composes its
	 *  master switch (graph.enabled off dims + disables the row; the
	 *  effective gate is server-side, per-turn fresh). */
	graph: GraphSettings | undefined;
	/** The `compaction` section — its own PUT (the threshold is engine
	 *  behavior, not an agent-section key; owner round 14, Agent tab). */
	compaction: CompactionSettings | undefined;
	/** Writes the composed WHOLE agent section (replace-PUT discipline). */
	onSectionChange: (next: AgentSettings) => void;
	/** Writes the composed models section (slots — replace-PUT discipline). */
	onModelsChange: (next: ModelsSettings) => void;
	/** Writes the whole compaction section (replace-PUT discipline). */
	onCompactionChange: (next: CompactionSettings) => void;
}) {
	const t = useT();
	const a = t.settings.agent;
	const { catalog: body, failed: catalogFailed, refresh: refreshCatalog } = useModelCatalog();
	const catalog = body?.models;
	const slots = body?.slots;
	const [folderInput, setFolderInput] = useState("");
	const [folderError, setFolderError] = useState<string | null>(null);
	const [prompts, setPrompts] = useState<PromptView | null>(null);
	const [openSegment, setOpenSegment] = useState<string | null>(null);
	const [segmentDraft, setSegmentDraft] = useState<Record<string, string>>({});
	const [segmentStatus, setSegmentStatus] = useState<string | null>(null);
	/** One open dropdown for the whole section: which slot (or per-role
	 *  override row), which kind. */
	const [openMenu, setOpenMenu] = useState<{ target: ModelSlotName | BackgroundModelRole; kind: "model" | "thinking" | "cache" } | null>(null);
	/** The slots whose per-role override rows are unfolded (collapsed by default). */
	const [openRoles, setOpenRoles] = useState<ReadonlySet<ModelSlotName>>(new Set());
	const [advancedModels, setAdvancedModels] = useState(false);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	/** Re-read the prompt-segment view — the signal seam for the
	 *  2026-09-26 state-echo fix: the view's `enabled` flags DERIVE from
	 *  the settings record's agent switches (the toggle's truth lives
	 *  here, not in the `agent` prop), so an agent-section write must
	 *  re-read it or the toggle keeps painting its pre-write state until
	 *  a remount. Keeps the last-good view on a failed re-read (the
	 *  initial mount fetch below owns the loading/null state). */
	const readPrompts = useCallback(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: PromptView) => setPrompts(body))
			.catch(() => {});
	}, []);

	// The shared catalog seeds the first frame and refreshes per mount and
	// keys/models signal. Settings props still own saved selections/levels.
	useSettingsSaved((section) => {
		// THE state-echo root cause: the prompt switches write through the
		// agent section, but this view (the toggles' truth) never re-read —
		// the settings-saved law (every reader re-reads) was missing this
		// one reader.
		if (section === "agent") readPrompts();
	});

	useEffect(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: PromptView) => setPrompts(body))
			.catch(() => setPrompts(null));
	}, []);

	// The dropdown contract (the chat model selector's, mirrored): any
	// click outside the open menu — or an Esc — closes it. Esc is CLAIMED
	// with stopPropagation so the settings dialog behind does NOT also
	// close. A pointerdown on the backdrop is left for the dialog (its own
	// click closes everything); a click inside the dialog just closes us.
	useEffect(() => {
		if (openMenu === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setOpenMenu(null);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpenMenu(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [openMenu]);

	async function saveSegment(path: string, text: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			setSegmentStatus(a.saveFailed(localizeServerError(String((await res.json().catch(() => ({}))).error ?? res.status), t)));
			return;
		}
		readPrompts();
		setSegmentStatus(a.saved);
		// Auto-on (owner ruling, refined 2026-09-26): writing an override and
		// putting it to work are ONE action — a save with the switch off was
		// the "did something, changed nothing" trap (the composed prompt
		// stayed the default). The file exists now, so the ON switch the
		// agent-section validation requires is legal; the order (file, then
		// switch) is the safe one. Saving an edit while already on rides
		// through — the switch write is idempotent at the record level.
		if (agent?.prompts?.[path] !== true) {
			onSectionChange(composePromptSwitch(agent, path, true));
		}
	}

	async function deleteSegment(path: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, { method: "DELETE" });
		if (!res.ok) {
			setSegmentStatus(a.deleteFailed(res.status));
			return;
		}
		// Auto-off — the mirror of save's auto-on: deleting the file while
		// the switch is on would orphan an ON record switch (the agent-section
		// validation 400s every later write while the UI's toggle can no
		// longer reach the OFF escape hatch — the trap found in live verify
		// 2026-09-26). Composing the OFF here keeps the record clean.
		if (agent?.prompts?.[path] === true) {
			onSectionChange(composePromptSwitch(agent, path, false));
		}
		readPrompts();
		setSegmentStatus(a.deleted);
	}

	const segmentRow = (info: PromptRow) => {
		const fileExists = info.overrideText !== null;
		const open = openSegment === info.path;
		// The Save affordance (owner ruling, refined 2026-09-26): clickable
		// only when there's something to save — the draft differs from
		// what's on disk. An unchanged editor shows a grayed, inert Save
		// (the always-active button was the "doesn't feel like it does
		// anything" half of the report).
		const draft = segmentDraft[info.path] ?? info.overrideText ?? "";
		const dirty = draft !== (info.overrideText ?? "");
		return (
			<div key={info.path} data-testid={`prompt-segment-${info.path}`}>
				<SettingsRow
					label={info.path}
					// Overhaul rulings (2026-09-26, refined): the small text
					// states WHICH VERSION IS IN USE — nothing when the
					// default composes (even with a saved override sitting
					// on disk unused), "Your version is in use" when the
					// switch is on. The switch's meaning becomes legible
					// through this line.
					hint={[info.usageHint, info.enabled ? a.promptInUse : undefined].filter(Boolean).join(" · ") || undefined}
					testid={`prompt-row-${info.path}`}
				>
					{/* Graying ruling: ONLY the toggle dims without an
					    override file — the file name above stays
					    full-contrast (the whole-row dim is dead). */}
					<span className={fileExists ? undefined : "opacity-40"}>
						<Toggle
							checked={info.enabled}
							disabled={!fileExists}
							label={a.promptAria(info.path)}
							onChange={(on) => onSectionChange(composePromptSwitch(agent, info.path, on))}
						/>
					</span>
				</SettingsRow>
				<button
					type="button"
					onClick={() => {
						setOpenSegment(open ? null : info.path);
						setSegmentStatus(null);
					}}
					className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
				>
					{open ? a.hideText : a.showText}
				</button>
				{open && (
					<div className="mt-1 flex flex-col gap-2">
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{a.source}</p>
							<textarea
								readOnly
								dir="ltr"
								value={info.sourceText}
								aria-label={a.sourceAria}
								className="h-24 w-full resize-y rounded-sm border border-border bg-muted p-2 font-ui text-xs text-muted-foreground"
							/>
						</div>
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{a.override}</p>
							<textarea
								dir="ltr"
								value={segmentDraft[info.path] ?? info.overrideText ?? ""}
								onChange={(e) => setSegmentDraft({ ...segmentDraft, [info.path]: e.target.value })}
								aria-label={a.overrideAria}
								placeholder={a.overridePlaceholder}
								className="h-24 w-full resize-y rounded-sm border border-border bg-background p-2 font-ui text-xs text-foreground outline-none"
							/>
						</div>
						<div className="flex items-center gap-3">
							<button
								type="button"
								disabled={!dirty}
								onClick={() => void saveSegment(info.path, segmentDraft[info.path] ?? "")}
								className={
									dirty
										? "text-xs text-foreground underline-offset-2 hover:underline"
										: "cursor-not-allowed text-xs text-muted-foreground/40 underline-offset-2"
								}
							>
								{t.common.actions.save}
							</button>
							{fileExists && (
								<button
									type="button"
									onClick={() => void deleteSegment(info.path)}
									className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-danger hover:underline"
								>
									{t.common.actions.delete}
								</button>
							)}
							{/* The quiet inline confirmation — next to the
							    action, not the old path-echoing line at the
							    section's bottom (production-copy: no file
							    paths in user-facing status). One editor is
							    open at a time (openSegment), so one shared
							    status reads unambiguously. */}
							{segmentStatus && (
								<p dir={textDirection(segmentStatus)} className="text-xs text-muted-foreground/70" data-testid="segment-status">
									{segmentStatus}
								</p>
							)}
						</div>
					</div>
				)}
			</div>
		);
	};



	// Resolved through the SAME core resolver the server's effective
	// settings use (the GraphSection precedent): the hint and placeholder
	// report exactly the number the trigger waits for.
	const resolvedCompaction = resolveSettings(
		compaction === undefined ? null : { version: 1, compaction },
	).compaction;

	/** Per-role overrides beneath a tier, collapsed by default. */
	const roleOverrides = (slot: ModelSlotName) => {
		if (slot === "strong") return null;
		const expanded = openRoles.has(slot);
		return (
			<>
				<button
					type="button"
					data-testid={`role-overrides-toggle-${slot}`}
					aria-expanded={expanded}
					onClick={() => {
						setOpenMenu(null);
						setOpenRoles((prev) => {
							const next = new Set(prev);
							if (next.has(slot)) next.delete(slot);
							else next.add(slot);
							return next;
						});
					}}
					className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
				>
					<ChevronRightIcon className={cn("size-3", expanded ? "rotate-90" : "rtl:-scale-x-100")} />
					{a.roles.toggle}
				</button>
				{expanded && BACKGROUND_MODEL_ROLES.filter((role) => ROLE_SLOT[role] === slot).map((role) => {
					const override = agent?.models?.[role];
					const name = a.roles.names[role];
					const isOpen = openMenu?.target === role;
					return (
						<SettingsRow key={role} label={name} testid={`role-row-${role}`}>
							<span ref={isOpen ? menuAnchorRef : undefined} className="relative flex items-center gap-2">
								{override?.model && (
									<button
										type="button"
										data-testid={`role-reset-${role}`}
										onClick={() => onSectionChange(composeRoleModel(agent, role, null))}
										className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
									>
										{a.roles.sameAsTier}
									</button>
								)}
								<MenuTrigger
									value={override?.model ? prettyModel(override.model.id) : ""}
									hint={override?.model ? `${override.model.provider}:${override.model.id}` : undefined}
									emptyLabel={a.roles.sameAsTier}
									ariaLabel={a.roles.modelAria(name)}
									testid={`role-model-${role}`}
									open={isOpen}
									onClick={() => setOpenMenu(isOpen ? null : { target: role, kind: "model" })}
									widthClass="min-w-20"
								/>
								{isOpen && (
									<MenuShell
										preferredSide="down"
										anchorTestid={`role-model-${role}`}
										testid={`role-model-menu-${role}`}
										menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										<ModelMenuList
											models={catalog ?? undefined}
											effectiveId={override?.model?.id}
											effectiveProvider={override?.model?.provider}
											vision={role === "visualMaker"}
											onPick={(entry) => {
												onSectionChange(composeRoleModel(agent, role, { provider: entry.provider, id: entry.id }));
												setOpenMenu(null);
											}}
										/>
									</MenuShell>
								)}
							</span>
						</SettingsRow>
					);
				})}
			</>
		);
	};

	return (
		<>
			<SettingsGroup label={a.groups.models} testid="group-models">
				<button
					type="button"
					data-testid="models-advanced"
					aria-expanded={advancedModels}
					onClick={() => { setAdvancedModels(!advancedModels); setOpenMenu(null); }}
					className="mb-1 self-start text-xs text-muted-foreground hover:text-foreground"
				>{advancedModels ? a.hideAdvanced : a.showAdvanced}</button>
				{catalogFailed && <p role="alert" className="text-xs text-danger">{a.catalogFailed}<button type="button" className="underline" onClick={refreshCatalog}>{t.common.actions.retry}</button></p>}
				{MODEL_SLOTS.map((slot) => {
					const override = models?.[slot];
					const modelId = override?.model?.id ?? "";
					const provider = override?.model?.provider ?? "";
					const thinking = override?.thinkingLevel ?? "";
					// The tier's resolved pin is machinery only now (owner, fix
					// wave): the UI never names the factory fallback — the hint
					// carries the roster, the triggers read "—" when unpicked — but
					// the pin still governs the thinking level LIST when no override
					// names a model to read levels from.
					const pin = slots?.[slot];
					// The model whose levels govern the thinking list: the
					// override, else the resolved pin (when it's in the federated
					// catalog); the standard ladder as the last fallback.
					const coord = override?.model ?? pin?.model;
					const chosen = coord ? catalog?.find((m) => m.id === coord.id && m.provider === coord.provider) : undefined;
					const levels = chosen ? chosen.supportedLevels : THINKING_LEVELS;
					const thisMenuOpen = openMenu?.target === slot ? openMenu.kind : null;
					return (
						<Fragment key={slot}>
						<SettingsRow
							label={a.slots[slot].label}
							hint={a.slots[slot].roster}
							testid={`slot-row-${slot}`}
						>
							{/* The anchor for the outside-click contract is the
							    span holding BOTH triggers of the open menu. */}
							<span
								ref={thisMenuOpen ? menuAnchorRef : undefined}
								className={`relative flex items-center gap-2 ${advancedModels ? "shrink-0" : ""}`}
								onKeyDown={(event) => {
									// Portal events bubble here too: close this menu, not the dialog.
									if (thisMenuOpen === "cache" && event.key === "Escape") {
										event.preventDefault(); event.stopPropagation(); setOpenMenu(null);
									}
								}}
							>
								{slot !== "strong" && <><ChatGPTBackgroundAccess provider={coord?.provider} /><NativeSubscriptionBackgroundAccess provider={coord?.provider} /></>}
								<MenuTrigger
									value={modelId ? prettyModel(modelId) : ""}
									hint={modelId ? `${provider}:${modelId}` : undefined}
									emptyLabel="—"
									ariaLabel={a.slotModelAria(a.slots[slot].label)}
									testid={`slot-model-${slot}`}
									open={thisMenuOpen === "model"}
									onClick={() => setOpenMenu(thisMenuOpen === "model" ? null : { target: slot, kind: "model" })}
									widthClass="min-w-20"
								/>
								<MenuTrigger
									// Legacy display (chunk 2 item 4): no stored level + a known
									// model → the RESOLVED level (the ordering's first supported —
									// what the engine build runs). Display-only until a pick writes.
									value={(() => {
										const level = thinking || (chosen ? defaultOrderLevel(levels) : "");
										return level ? (t.common.thinkingLevels[level] ?? level) : "";
									})()}
									emptyLabel="—"
									ariaLabel={a.slotThinkingAria(a.slots[slot].label)}
									testid={`slot-thinking-${slot}`}
									open={thisMenuOpen === "thinking"}
									onClick={() => setOpenMenu(thisMenuOpen === "thinking" ? null : { target: slot, kind: "thinking" })}
									widthClass="w-20"
								/>
								{advancedModels && <MenuTrigger
									value={cacheRetentionLabel(override?.cacheRetention, t.settings.cacheRetention)}
									emptyLabel={a.cacheDefault}
									ariaLabel={a.cacheRetentionAria(a.slots[slot].label)}
									testid={`slot-cache-${slot}`}
									open={thisMenuOpen === "cache"}
									disabled={!override?.model}
									onClick={() => setOpenMenu(thisMenuOpen === "cache" ? null : { target: slot, kind: "cache" })}
									widthClass="w-40"
								/>}
								{advancedModels && thisMenuOpen === "cache" && <MenuShell
									preferredSide="down"
									anchorTestid={`slot-cache-${slot}`}
									testid={`slot-cache-menu-${slot}`}
									menuClass="flex w-80 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
								>
									<CacheRetentionMenu value={override?.cacheRetention} onPick={(value) => {
										onModelsChange(composeSlotCacheRetention(models, slot, value));
										setOpenMenu(null);
									}} />
								</MenuShell>}
								{thisMenuOpen === "model" && (
									<MenuShell
										preferredSide="down"
											anchorTestid={`slot-model-${slot}`}
										testid={`slot-model-menu-${slot}`}
										menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										<ModelMenuList
											models={catalog ?? undefined}
											effectiveId={modelId}
											effectiveProvider={provider}
											vision={slot === "vision"}
											onPick={(entry) => {
												// Auto-populate (chunk 2, owner: "populate everywhere"): the
												// fresh pick writes a level — the stored one rides as-is
												// (the write clamps server-side), else the ordering's level.
												const next = populateLevel(thinking || undefined, entry.supportedLevels);
												onModelsChange(composeSlotModel(models, slot, entry.provider, entry.id, next));
												setOpenMenu(null);
											}}
											footer={
												catalog && catalog.length === 0
													? a.noModelsFooter
													: a.tierFooter
											}
										/>
									</MenuShell>
								)}
								{thisMenuOpen === "thinking" && (
									<MenuShell
										preferredSide="down"
											anchorTestid={`slot-thinking-${slot}`}
										testid={`slot-thinking-menu-${slot}`}
										menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										<ThinkingMenuList
											levels={levels.map(String)}
											// The ✓ sits on the RESOLVED level for legacy unset records —
											// the same one the trigger shows.
											effectiveLevel={thinking || (chosen ? defaultOrderLevel(levels) : undefined)}
											onPick={(level) => {
												onModelsChange(composeSlotModel(models, slot, provider, modelId, level));
												setOpenMenu(null);
											}}
										/>
									</MenuShell>
								)}
							</span>
						</SettingsRow>
						{roleOverrides(slot)}
						</Fragment>
					);
				})}
			</SettingsGroup>

			<SettingsGroup label={a.groups.tools} testid="group-tools">
				{/* The prober's graph tools (wave 7, owner ruling 2026-09-23):
				    FIRST row of the group — its subject is the map, its
				    mechanism is agent capability, so it lives in Tools but
				    NOT in the tool-toggles list. Its own agent-section key
				    (agent.graphTools), the search-row hint discipline: a
				    smaller line under it explaining what it is — this
				    connects prior sessions' knowledge into new ones. */}
				{(() => {
					const graphOn = graph?.enabled ?? true;
					return (
						<SettingsRow
							label={a.graphTools}
							hint={graphOn ? a.graphToolsHint : a.graphDisabled}
							testid="graph-tools-row"
							dimmed={!graphOn}
						>
							<Toggle
								checked={agent?.graphTools?.enabled ?? true}
								disabled={!graphOn}
								label={a.graphToolsAria}
								onChange={(on) => onSectionChange(composeGraphTools(agent, on))}
							/>
						</SettingsRow>
					);
				})()}
				{/* The quizzing mechanic (owner 2026-09-27): segmented — exactly one
				    of Multiple choice / Free recall is active; the choice swaps which
				    quizzing tool BOTH agents carry (prober checks + teach checks).
				    Persisted as agent.tools.explain; absent = Multiple choice. */}
				{(() => {
					const free = agent?.tools?.explain === true;
					return (
						<SettingsRow
							label={a.quizzing}
							hint={a.quizzingHint}
							testid="quiz-mechanics-row"
						>
							<div
								role="radiogroup"
								aria-label={a.quizzingAria}
								className="flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
								>
								{(["choice", "free"] as const).map((m) => {
									const active = m === "free" ? free : !free;
									return (
										<button
											key={m}
											type="button"
											role="radio"
											aria-checked={active}
											data-testid={`quiz-mechanics-${m}`}
											onClick={() => onSectionChange(composeQuizMechanics(agent, m))}
											className={cn(
												"h-8 rounded-md px-3 text-sm font-medium transition-colors",
												active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
											)}
										>
											{m === "choice" ? a.multipleChoice : a.freeRecall}
										</button>
									);
								})}
							</div>
						</SettingsRow>
					);
				})()}
				{TOGGLE_TOOLS.map((id) => (
					<SettingsRow
						key={id}
						label={a.toolLabel(a.tools[id])}
						testid={`tool-row-${id}`}
					>
						<Toggle
							checked={agent?.tools?.[id] ?? true}
							label={a.toolAria(a.tools[id])}
							onChange={(on) => onSectionChange(composeTool(agent, id, on))}
						/>
					</SettingsRow>
				))}
				{(() => {
					const folders = agent?.fileAccess?.folders ?? [];
					const restricted = Boolean(fileAccessError) || agent?.fileAccess?.restricted === true;
					const effectiveAgent = fileAccessError ? { ...agent, fileAccess: { restricted: true, folders } } : agent;
					const shownFileAccessError = fileAccessError ? localizeServerError(fileAccessError, t) : null;
					const addFolder = () => {
						const next = folderInput.trim();
						if (!isFolderEntry(next)) { setFolderError(a.fileAccess.absolutePathError); return; }
						if (!folders.includes(next)) onSectionChange(composeAddFolder(effectiveAgent, next));
						setFolderInput("");
						setFolderError(null);
					};
					return (
						<div data-testid="file-access-row" className="flex flex-col gap-2">
							<SettingsRow label={a.fileAccess.title} hint={!restricted
								? a.fileAccess.broadHint
								: folders.length ? a.fileAccess.restrictedHint
									: a.fileAccess.emptyRestrictedHint}>
								<div className="flex items-center gap-2 text-xs">
									<span>{a.fileAccess.restrict}</span>
									<Toggle checked={restricted} label={a.fileAccess.restrict} onChange={(on) => onSectionChange(composeFileRestriction(effectiveAgent, on))} />
								</div>
							</SettingsRow>
							{shownFileAccessError && <p role="alert" dir={textDirection(shownFileAccessError)} data-testid="file-access-config-error" className="text-xs text-danger">{shownFileAccessError}</p>}
							<div className="flex gap-2 ps-3">
								<input dir="ltr" value={folderInput} aria-label={a.fileAccess.folderAria} data-testid="file-access-add" placeholder={a.fileAccess.folderPlaceholder}
									onChange={(event) => { setFolderInput(event.target.value); setFolderError(null); }}
									onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addFolder(); } }}
									className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 font-ui text-xs" />
								<button type="button" data-testid="file-access-add-button" disabled={!folderInput.trim()} onClick={addFolder} className="rounded-sm border border-border px-2 text-xs disabled:opacity-40">{a.fileAccess.addFolder}</button>
							</div>
							{folderError && <p role="alert" data-testid="file-access-input-error" className="ps-3 text-xs text-danger">{folderError}</p>}
							{folders.map((folder) => (
								<div key={folder} data-testid="file-access-folder" className="flex items-center justify-between gap-4 ps-3 text-xs">
									<span title={folder} dir="ltr" className="min-w-0 truncate font-ui text-muted-foreground">{folder}</span>
									<button type="button" aria-label={a.fileAccess.removeFolderAria(folder)} data-testid="file-access-remove"
										onClick={() => onSectionChange(composeRemoveFolder(effectiveAgent, folder))}
										className="rounded-sm px-1.5 text-muted-foreground hover:text-foreground">{t.common.actions.remove}</button>
								</div>
							))}
						</div>
					);
				})()}
			</SettingsGroup>

			<SettingsGroup label={a.groups.context} testid="group-context">
				<SettingsRow
					label={a.compactionThreshold}
					hint={t.settings.graph.tokens(resolvedCompaction.thresholdTokens)}
					testid="compaction-row-threshold"
				>
					<CommitInput
						type="number"
						value={String(compaction?.thresholdTokens ?? "")}
						placeholder={String(resolvedCompaction.thresholdTokens)}
						ariaLabel={a.compactionAria}
						testid="input-compaction-threshold"
						onCommit={(v) => {
							// Empty = factory default (the budget row's discipline):
							// absence is the unset for numbers.
							if (v === "") {
								onCompactionChange({ ...compaction, thresholdTokens: undefined });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
							// Mirror the server floor (anti-churn: each compaction
							// keeps a ~20k-token tail); no ceiling — the effective
							// trigger is min(threshold, contextWindow − 16k) anyway.
							onCompactionChange({
								...compaction,
								thresholdTokens: Math.max(COMPACTION_THRESHOLD_FLOOR, Math.round(n)),
							});
						}}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label={a.groups.prompts} testid="group-prompts">
				{prompts === null ? (
					<p className="text-xs text-muted-foreground/70">{a.loadingPrompts}</p>
				) : (
					<div className="flex flex-col gap-4">
						{/* Teacher, Prober, Practice, Shared — shared chunks once,
						    each agent's own section in prompt-assembly order. */}
						{sectionedSegments(prompts, a).map((section) => (
							<div key={section.id} data-testid={`prompt-section-${section.id}`}>
								<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">
									{section.label}
								</p>
								<div className="flex flex-col gap-2">
									{section.segments.map((info) => segmentRow(info))}
								</div>
							</div>
						))}
					</div>
				)}
			</SettingsGroup>
		</>
	);
}
