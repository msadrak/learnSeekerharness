"use client";
/**
 * THE SETTINGS DIALOG (settings-app wave, 2026-09-20): the thin settings
 * page graduated into the designed surface — a centered modal over
 * everything, left section nav + one scrolling content column.
 *
 * Owner decisions this wave:
 * - Dialog, not a page: opens over whatever screen you're on (the payoff:
 *   appearance edits restyle the chat LIVE behind the dialog). Escape,
 *   backdrop, and ✕ all close. Modal-only — /settings redirects, so
 *   nothing links into a dead surface.
 * - Left section nav in the app's mono chrome (text-only, session-list
 *   language — active = bg-accent), no icons, matching the minimal-color
 *   doctrine.
 * - The dialog is surface-agnostic by construction: the sections talk to
 *   /api/settings* and localStorage only, so this shell can be re-mounted
 *   as a true OS window in the Electron round with near-zero churn.
 *
 * The record + the single `write` seam moved here from the thin page:
 * one record instance for the whole dialog, sections write through it,
 * switching sections never refetches.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import {
	CURRENT_SETTINGS_VERSION,
	type AgentSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type UserSettings,
} from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { SettingsSection } from "./controls.tsx";
import { UpdateSettings } from "./update-settings.tsx";
import { AgentSection } from "./agent-section.tsx";
import type { ModelsSettings } from "@/src/core";
import { MENU_CLOSE_EVENT, MENU_OPEN_EVENT } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { KeysSection } from "./keys-section.tsx";
import { DictationSection } from "./dictation-section.tsx";
import { SearchSection } from "./search-section.tsx";
import { Hint } from "@/components/ui/hint";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";
import { ChatGPTUIProvider } from "./chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider } from "./subscription-connections.tsx";
import { useT } from "@/components/i18n";
import { localizeServerError } from "@/lib/i18n/server-errors";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

/** Owner (2026-09-20): hints earn their place — mechanics-explaining
 *  prose is out; only the keyboard note stays (storage location is a
 *  real question users ask). */
const SECTIONS = [
	{ id: "keys" },
	{ id: "dictation" },
	{ id: "search" },
	{ id: "agent" },
	{ id: "appearance" },
	{ id: "graph" },
	{ id: "keyboard" },
	{ id: "general" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** `open(section?, row?)` — the optional ROW deep-links into a keys
 *  section (keys, dictation or search) with that row unfolded (zero-keys
 *  wave: the dictation error's click lands on the Deepgram row). `row` is
 *  the KEY ID (the env-var name, e.g. DEEPGRAM_API_KEY — the section's
 *  openRow state), not the row's testid. */
const DialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });

/** AppShell-level mount: the sidebar row and the mod+, chord call this.
 *  `open(section)` lands the dialog on a specific section (the first-run
 *  setup flow deep-links to Keys when no provider key exists yet). */
export function SettingsDialogProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [show, setShow] = useState(false);
	const [landOn, setLandOn] = useState<SectionId>("keys");
	const [landOnRow, setLandOnRow] = useState<string | null>(null);
	const open = useCallback((section?: string, row?: string) => {
		setLandOn(section ? section as SectionId : "keys");
		setLandOnRow(row ?? null);
		setShow(true);
	}, []);
	useEffect(() => window.lh?.onOpenSettings?.((section) => open(section)), [open]);
	return (
		<ChatGPTUIProvider><NativeSubscriptionUIProvider><DialogContext.Provider value={{ open }}>
			{children}
			{show && (
				<SettingsDialog onClose={() => setShow(false)} initialSection={landOn} initialRow={landOnRow} />
			)}
		</DialogContext.Provider></NativeSubscriptionUIProvider></ChatGPTUIProvider>
	);
}

export function useSettingsDialog() {
	return useContext(DialogContext);
}

function SettingsDialog({
	onClose,
	initialSection,
	initialRow,
}: {
	onClose: () => void;
	initialSection: SectionId;
	/** The keys-section row to unfold (see DialogContext above). */
	initialRow: string | null;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	// Dim, softly blurred backdrop; a genuine backdrop click closes, the
	// dialog body stops propagation.
	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
			data-testid="settings-backdrop"
			{...backdropDismiss}
		>
			<SettingsDialogBody onClose={onClose} initialSection={initialSection} initialRow={initialRow} />
		</div>,
		document.body,
	);
}

/** The dialog without the portal/backdrop — the SSR-testable frame
 *  (portals render nothing under renderToStaticMarkup). */
export function SettingsDialogBody({
	onClose,
	initialSection = "keys",
	initialRow = null,
}: {
	onClose: () => void;
	initialSection?: SectionId;
	/** The keys row to unfold on arrival (null = none). While-open
	 *  retargets follow it exactly like initialSection below. */
	initialRow?: string | null;
}) {
	const t = useT();
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(
		undefined,
	);
	const [fileAccessError, setFileAccessError] = useState<string | null>(null);
	// MenuShell open-count — drives the content column's scroll lock.
	const [openMenus, setOpenMenus] = useState(0);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// Scroll-lock (fix wave, owner ruling: the scrollbar MAY stay,
	// scrolling must NOT happen, nothing may move): the content column
	// keeps overflow-y-auto — the scrollbar and every width stay exactly
	// as they are — and while any MenuShell is open, non-passive wheel +
	// touchmove listeners on the column preventDefault. React attaches
	// synthetic wheel/touch passively at the root, so this needs the
	// native-listener ref seam.
	useEffect(() => {
		const el = contentRef.current;
		if (!el || openMenus === 0) return;
		const block = (e: Event) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => {
			el.removeEventListener("wheel", block);
			el.removeEventListener("touchmove", block);
		};
	}, [openMenus]);

	useEffect(() => {
		const onOpen = () => setOpenMenus((n) => n + 1);
		const onClose = () => setOpenMenus((n) => Math.max(0, n - 1));
		window.addEventListener(MENU_OPEN_EVENT, onOpen);
		window.addEventListener(MENU_CLOSE_EVENT, onClose);
		return () => {
			window.removeEventListener(MENU_OPEN_EVENT, onOpen);
			window.removeEventListener(MENU_CLOSE_EVENT, onClose);
		};
	}, []);
	const [active, setActive] = useState<SectionId>(initialSection);
	// A deep-link fired while the dialog is ALREADY open (first exercised by
	// the wave-6 embedding picker's "Add a provider key first…" link — the
	// picker itself died with wave 7, the mechanism is general) changes
	// initialSection under our feet — follow it, or the link silently does
	// nothing.
	useEffect(() => {
		setActive(initialSection);
	}, [initialSection]);

	// Fetch once per dialog mount. 200 {settings: null} is FIRST BOOT
	// (no record = factory everything), not a failure — the error state is
	// a non-200 or a network throw only.
	useEffect(() => {
		fetch("/api/settings")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)),
			)
			.then((body: { settings: UserSettings | null; fileAccessError?: string }) => {
				setRecord(body.settings ?? { version: CURRENT_SETTINGS_VERSION });
				setFileAccessError(body.fileAccessError ?? null);
			})
			.catch(() => setRecord(null));
	}, []);

	// Escape closes — the layered-dismiss convention (Esc is dead for the
	// sections' own editors while they hold focus; this listener is the
	// dialog's outer layer).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW (owner, keyboard round 2026-10-06): claim
				// at the document level — the window chain (dictation →
				// abort) must not also act. One Esc, one action.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	/** ONE writer for the whole dialog: PUT the whole section, keep the
	 *  record mirror in sync, surface route errors as a toast (a 400 is a
	 *  schema mistake caught by the validation surface). */
	const write = useCallback(
		async (
			section: "general" | "agent" | "models" | "appearance" | "graph" | "compaction",
			body: object,
		) => {
			const res = await fetch(`/api/settings/${section}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				const navId =
					section === "models" || section === "compaction" ? "agent" : section;
				toast.error(
					t.settings.dialog.saveFailed(
						t.settings.dialog.nav[navId] ?? section,
						localizeServerError(String(detail.error ?? res.status), t),
					),
				);
				return;
			}
			// Server truth, never the request body (fix wave, owner repro):
			// the models section clamps pinned thinking levels on write
			// (bd68486) — a swap that rides an unsupported level lands
			// CLAMPED in the record, and the writing surface must show the
			// stored value in this same interaction, not the optimistic one.
			const reply = (await res.json().catch(() => null)) as { settings?: UserSettings; fileAccessError?: string } | null;
			const stored = reply?.settings;
			setFileAccessError(reply?.fileAccessError ?? null);
			setRecord(
				(prev) =>
					stored ?? ({ ...(prev ?? {}), [section]: body }) as UserSettings,
			);
			notifySettingsSaved(section);
			if (section === "appearance")
				onAppearanceChange(body as AppearanceSettings);
		},
		[onAppearanceChange, t],
	);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={t.settings.dialog.title}
			data-testid="settings-dialog"
			className="settings-dialog-pop flex h-[620px] max-h-[85vh] w-[920px] max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-float"
			onClick={(e) => e.stopPropagation()}
		>
			{/* Header — the app's quiet CMU title language. */}
			<header className="flex h-16 shrink-0 items-center gap-3 border-b border-border/60 px-6">
				<h2 className="font-title text-xl tracking-tight">{t.settings.dialog.title}</h2>
				<Hint
						// Esc closes the dialog (its own listener) — surface it.
						label={t.common.actions.close}
						binding="escape"
						side="left"
					>
						<button
					type="button"
					aria-label={t.settings.dialog.close}
					data-testid="settings-close"
					className="ms-auto flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={onClose}
				>
					<svg
						viewBox="0 0 16 16"
						className="mx-auto size-3.5"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<path d="M4 4l8 8M12 4l-8 8" />
					</svg>
				</button>
					</Hint>
			</header>

			<div className="flex min-h-0 flex-1">
				{/* Left nav — text-only, the session-list mono language,
					    active = bg-accent. */}
				<nav
					aria-label={t.settings.dialog.sections}
					data-testid="settings-nav"
					className="flex w-48 shrink-0 flex-col gap-0.5 border-e border-border/60 p-3"
				>
					{SECTIONS.map((s) => (
						<button
							key={s.id}
							type="button"
							data-testid={`settings-nav-${s.id}`}
							aria-current={active === s.id}
							className={`relative rounded-lg px-3 py-2 text-start font-ui text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
								active === s.id
									? "bg-accent font-medium text-foreground before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:rounded-full before:bg-primary"
									: "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
							}`}
							onClick={() => setActive(s.id)}
						>
							{t.settings.dialog.nav[s.id]}
						</button>
					))}
				</nav>

				{/* Content column — one section at a time, this scrolls — and
				    LOCKS while any MenuShell is open (owner ruling: no
				    scrolling with a dropdown down; MenuShell announces
				    open/close, the count keeps overlap honest). The lock
				    intercepts wheel/touch instead of hiding the scrollbar —
				    nothing may shift when the lock engages. */}
				<div
					ref={contentRef}
					className="min-w-0 flex-1 overflow-y-auto"
					data-testid="settings-content"
				>
					{record === undefined ? (
						<div className="flex flex-col gap-2 p-6">
							{[0, 1, 2, 3].map((i) => (
								<Skeleton key={i} className="h-7 w-full" />
							))}
							<span className="sr-only">{t.settings.dialog.loading}</span>
						</div>
					) : record === null ? (
						<p className="p-6 text-xs text-muted-foreground">
							{t.settings.dialog.loadFailed}
						</p>
					) : (
						<div>
							{active === "general" && (
								<SettingsSection
									title={t.settings.dialog.nav.general}
									testid="section-general"
								>
									<UpdateSettings
										autoUpdate={record.general?.autoUpdate ?? true}
										onAutoUpdateChange={(on) =>
											void write("general", { ...record.general, autoUpdate: on })
										}
									/>
								</SettingsSection>
							)}
							{active === "keys" && (
								<SettingsSection title={t.settings.dialog.nav.keys} testid="section-keys">
									<KeysSection initialRow={initialRow ?? undefined} />
								</SettingsSection>
							)}
							{active === "dictation" && (
								<SettingsSection title={t.settings.dialog.nav.dictation} testid="section-dictation">
									<DictationSection initialRow={initialRow ?? undefined} />
								</SettingsSection>
							)}
							{active === "search" && (
								<SettingsSection title={t.settings.dialog.nav.search} testid="section-search">
									<SearchSection
										agent={record.agent}
										onAgentChange={(next: AgentSettings) => void write("agent", next)}
										initialRow={initialRow ?? undefined}
									/>
								</SettingsSection>
							)}
							{active === "agent" && (
								<SettingsSection
									title={t.settings.dialog.nav.agent}
									testid="section-agent"
								>
									<AgentSection
										agent={record.agent}
										fileAccessError={fileAccessError}
										models={record.models}
										graph={record.graph}
										compaction={record.compaction}
										onModelsChange={(next: ModelsSettings) =>
											void write("models", next)
										}
										onSectionChange={(next: AgentSettings) =>
											void write("agent", next)
										}
										onCompactionChange={(next: CompactionSettings) =>
											void write("compaction", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "appearance" && (
								<SettingsSection
									title={t.settings.dialog.nav.appearance}
									testid="section-appearance"
								>
									<AppearanceSection
										appearance={record.appearance}
										onSectionChange={(next: AppearanceSettings) =>
											void write("appearance", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "graph" && (
								<SettingsSection
									title={t.settings.dialog.nav.graph}
									testid="section-graph"
								>
									<GraphSection
										graph={record.graph}
										onSectionChange={(next: GraphSettings) =>
											void write("graph", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "keyboard" && (
								<SettingsSection
									title={t.settings.dialog.nav.keyboard}
									hint={t.settings.dialog.keyboardHint}
									testid="section-keyboard"
								>
									<KeyboardSection />
								</SettingsSection>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
