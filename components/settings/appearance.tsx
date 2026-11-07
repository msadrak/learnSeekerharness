"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders. The ONE thing the
 * variables can't reach — the mode — is dark-only this wave (the light
 * palette is designed in the later design wave; <html class="dark"> is
 * static in app/layout.tsx).
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Direction } from "radix-ui";
import { FACTORY_SETTINGS, type AppearanceMode, type AppearanceSettings } from "@/src/core";
import { languageDirection } from "@/lib/i18n/direction";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		language: delta?.language ?? f.language,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** One channel clamped on the dark curve: additive offsets matching today's
 *  hand-picked palette (#141414 → card #1c1c1c (+8) → accent #2a2a2a (+22)
 *  → border #434343 (+47)) — the "per-mode derivation in code" the schema
 *  promises, as the thinnest curve that keeps the palette's relationships. */
function raise(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.min(255, c + add).toString(16).padStart(2, "0")).join("")}`;
}

/** The derived palette a chosen background implies (dark curve): background
 *  itself, the raised surfaces (card/popover/secondary/muted, +8), the
 *  accent (+22), the edges (border/input, +47), and primary-foreground
 *  (the inverted text on primary = the background's own color, as today). */
export function derivedPalette(background: string): Record<string, string> {
	const card = raise(background, 8);
	const accent = raise(background, 22);
	const border = raise(background, 47);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": accent,
		"--border": border,
		"--input": border,
		"--primary-foreground": background,
	};
}

/** Pure: the concrete scheme a mode implies. "system" is unknown (null)
 *  until the OS preference has been read on the client. */
export function resolveScheme(mode: AppearanceMode, prefersLight: boolean | null): "dark" | "light" | null {
	if (mode !== "system") return mode;
	if (prefersLight === null) return null;
	return prefersLight ? "light" : "dark";
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. Pure —
 *  exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	scheme: "dark" | "light",
): Record<string, string> {
	const vars: Record<string, string> = {};
	// The derivation curve is dark-only; light keeps the stylesheet palette.
	if (a.background !== null && scheme === "dark") Object.assign(vars, derivedPalette(a.background));
	if (a.fontFamily !== null) {
		// Vazirmatn before the next/font var: its CLS fallback is Arial,
		// which would swallow Persian glyphs (see globals.css font stacks).
		vars["--font-prose"] = `"${a.fontFamily}", "Source Sans 3", var(--font-vazirmatn), var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars
	// were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** The concrete scheme in effect ("system" resolved; dark until known). */
	scheme: "dark" | "light";
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	scheme: "dark",
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({
	children,
	initialAppearance,
}: {
	children: React.ReactNode;
	/** The record's appearance section, read server-side by the root
	 *  layout — the first frame renders in the right language/direction. */
	initialAppearance?: AppearanceSettings;
}) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(initialAppearance);
	const language = resolveAppearance(delta).language;
	const appliedRef = useRef<string>("");

	// The vars apply on every change — stringified as the change signal.
	const mode = resolveAppearance(delta).mode;
	// OS preference, tracked only in "system" mode. null until the first
	// client read — the layout's inline script already set <html> then.
	const [prefersLight, setPrefersLight] = useState<boolean | null>(null);
	useEffect(() => {
		if (mode !== "system") return;
		const mq = window.matchMedia("(prefers-color-scheme: light)");
		setPrefersLight(mq.matches);
		const onChange = (e: MediaQueryListEvent) => setPrefersLight(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [mode]);
	const resolvedScheme = resolveScheme(mode, prefersLight);
	// Layout effect: descendants that sample CSS tokens in a passive effect
	// (graph canvas colours) must see the new scheme's variables.
	useLayoutEffect(() => {
		if (resolvedScheme === null) return;
		const root = document.documentElement;
		root.classList.toggle("dark", resolvedScheme === "dark");
		root.classList.toggle("light", resolvedScheme === "light");
	}, [resolvedScheme]);

	const vars = useMemo(() => appearanceVars(resolveAppearance(delta), resolvedScheme ?? "dark"), [delta, resolvedScheme]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty field = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever —
	// backgrounds never reset, toggles looked dead. Every name this effect
	// has ever set is tracked; names absent from the new set are removed so
	// the factory stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// The UI language lives on <html> (lang + dir): the layout renders the
	// server-read value; a live switch moves both here.
	useEffect(() => {
		const root = document.documentElement;
		root.lang = language;
		root.dir = languageDirection(language);
	}, [language]);

	// One fetch per app load: the record (sanitized server-side) carries the
	// delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance
				// slice is unknown-shaped here, so it goes through the same
				// resolve (absent/invalid fields = factory anyway).
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
			})
			.catch(() => {/* settings stay factory — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
	}, []);

	const scheme = resolvedScheme ?? "dark";
	const value = useMemo(
		() => ({ appearance: resolveAppearance(delta), scheme, onAppearanceChange }),
		[delta, scheme, onAppearanceChange],
	);
	return (
		<AppearanceContext.Provider value={value}>
			<Direction.Provider dir={languageDirection(language)}>{children}</Direction.Provider>
		</AppearanceContext.Provider>
	);
}