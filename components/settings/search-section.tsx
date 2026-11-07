"use client";
/**
 * The Search section: the search-engine preference row, then the search
 * tool keys. Split out of the Agent section and the Providers section
 * (Phase 5).
 *
 * Search engine (search wave, 2026-09-20, owner: no default — an engine
 * is live iff its key is present; with a key the engine AUTO-activates,
 * the explicit choice is only a preference between live engines): the
 * shared-menu look and the live reason line from /api/search. No engine
 * key at all → the row grays whole-row (a choice without a key would only
 * BLOCK another engine's auto-activation). Key presence comes from the
 * same /api/keys hook the key rows below use, so saving a key here lights
 * the row immediately.
 */

import { useEffect, useRef, useState } from "react";
import { MenuShell } from "@/components/menu-shell";
import { useT } from "@/components/i18n";
import { SEARCH_ENGINES, type AgentSettings, type SearchEngineId } from "@/src/core";
import { composeSearchEngine, MenuTrigger } from "./agent-section.tsx";
import { SettingsGroup, SettingsRow } from "./controls.tsx";
import { classifyKeys, ToolKeyRows } from "./keys-section.tsx";
import { useKeyStatuses } from "./use-key-statuses.ts";

interface SearchState {
	available: boolean;
	engine: string | null;
	reason: string;
}

export function SearchSection({
	agent,
	onAgentChange,
	initialRow,
}: {
	agent: AgentSettings | undefined;
	/** Writes the composed WHOLE agent section (replace-PUT discipline). */
	onAgentChange: (next: AgentSettings) => void;
	/** A deep-linked key row to unfold on arrival. */
	initialRow?: string;
}) {
	const t = useT();
	const a = t.settings.agent;
	const k = t.settings.keys;
	const ks = useKeyStatuses();
	/** The live search state (/api/search) — the row's reason line. */
	const [search, setSearch] = useState<SearchState | null>(null);
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLSpanElement>(null);
	const engine = agent?.search?.engine ?? null;

	// The reason line re-reads /api/search AFTER an engine write lands (the
	// write updates the `agent` prop) or a key lands — keying on both avoids
	// the race where the fetch beat the PUT and the hint contradicted the
	// trigger it sits under.
	useEffect(() => {
		fetch("/api/search")
			.then((r) => r.json())
			.then((body: SearchState) => setSearch(body))
			.catch(() => setSearch(null));
	}, [engine, ks.statuses]);

	// The dropdown contract (the chat model selector's, mirrored): any
	// click outside the open menu — or an Esc — closes it. Esc is CLAIMED
	// with stopPropagation so the settings dialog behind does NOT also close.
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

	const statuses = ks.statuses;
	const anyKey = SEARCH_ENGINES.some(({ envVar }) => statuses?.some((s) => s.id === envVar && s.present) === true);
	const hasKey = (id: SearchEngineId) => {
		const envVar = SEARCH_ENGINES.find((e) => e.id === id)?.envVar;
		return statuses?.some((s) => s.id === envVar && s.present) === true;
	};

	/** The search-engine menu row — label + the quiet live-key mark. */
	const engineOption = (
		id: SearchEngineId | "auto",
		label: string,
		active: boolean,
		live: boolean | null,
		onPick: () => void,
	) => (
		<button
			key={id}
			type="button"
			data-testid={`engine-option-${id}`}
			onClick={onPick}
			className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-muted ${
				active ? "bg-muted/60 text-card-foreground" : "text-card-foreground"
			}`}
		>
			<span>{label}</span>
			<span className="text-muted-foreground">
				{live === null ? (active && <span aria-hidden>✓</span>) : live ? <span aria-hidden>{a.engineKey}</span> : <span aria-hidden>{a.engineNoKey}</span>}
			</span>
		</button>
	);

	return (
		<>
			<SettingsRow
				label={a.searchEngine}
				hint={search?.reason ?? undefined}
				testid="search-engine-row"
				dimmed={!anyKey}
			>
				<span ref={anchorRef} className="relative flex items-center gap-2">
					<MenuTrigger
						value={SEARCH_ENGINES.find(({ id }) => id === engine)?.label ?? ""}
						emptyLabel={a.automatic}
						ariaLabel={a.searchEngine}
						testid="search-engine-trigger"
						open={open}
						onClick={() => setOpen((v) => !v)}
						widthClass="min-w-20"
						disabled={!anyKey}
					/>
					{open && (
						<MenuShell
							preferredSide="down"
							anchorTestid="search-engine-trigger"
							testid="search-engine-menu"
							menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
						>
							{engineOption("auto", a.automatic, engine === null, null, () => {
								onAgentChange(composeSearchEngine(agent, null));
								setOpen(false);
							})}
							{SEARCH_ENGINES.map(({ id, label }) =>
								engineOption(id, label, engine === id, hasKey(id), () => {
									onAgentChange(composeSearchEngine(agent, id));
									setOpen(false);
								}),
							)}
						</MenuShell>
					)}
				</span>
			</SettingsRow>
			<SettingsGroup label={k.search} testid="group-search">
				{statuses === null ? (
					<p className="text-xs text-muted-foreground/70">{k.loading}</p>
				) : (
					<ToolKeyRows
						statuses={classifyKeys(statuses, ks.providers).toolRows.filter((status) => status.id !== "DEEPGRAM_API_KEY")}
						ks={ks}
						initialRow={initialRow}
					/>
				)}
			</SettingsGroup>
		</>
	);
}
