"use client";
/**
 * Thin settings primitives (settings-app wave): the control kit the
 * settings dialog needs. Sections → groups → rows; everything SSRs clean
 * (render tests pin the sections' markup).
 *
 * The dependency graying (owner, 2026-09-20) follows the graph viewer's
 * render-panel convention: the WHOLE row dims (opacity-40, label and
 * control together) and the control itself locks — the row owns the dim.
 */

import { useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { textDirection } from "@/lib/i18n/direction";

/** A section block: pronounced mono heading + content. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One quiet line under the header — only where it earns its place. */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section data-testid={testid} className="p-6">
			<h2 className="text-sm font-semibold text-foreground">{title}</h2>
			{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
			<div className="mt-4 flex flex-col gap-1">{children}</div>
		</section>
	);
}

/** A labeled sub-group inside a section (owner, 2026-09-20: clear
 *  separation — Models / Tools / Prompts read as three blocks). */
export function SettingsGroup({
	label,
	children,
	testid,
}: {
	label: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<div data-testid={testid} className="mt-5 border-t border-border/60 pt-5 first:mt-0 first:border-t-0 first:pt-0">
			<p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
			<div className="flex flex-col gap-1">{children}</div>
		</div>
	);
}

/** One label + one control. Label left (with optional muted hint), control
 *  right — the settings row shape. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
	dimmed,
}: {
	label: string;
	hint?: ReactNode;
	children: React.ReactNode;
	testid?: string;
	/** Dependency graying, graph-view style: the whole row dims when the
	 *  control is inert (parent off, no file yet, …). */
	dimmed?: boolean;
}) {
	return (
		<div data-testid={testid} className={cn("flex items-center justify-between gap-4 border-b border-border/60 px-3 py-3 last:border-b-0", dimmed && "opacity-40")}>
			<span className="min-w-0">
				{/* Labels/hints may carry non-dictionary text (prompt paths, the
				    server's search reason) — each gets its own direction. */}
				<span dir={textDirection(label)} className="block font-ui text-sm font-medium text-foreground lh-align-page">{label}</span>
				{hint && <span dir={typeof hint === "string" ? textDirection(hint) : undefined} className="mt-0.5 block text-xs text-muted-foreground lh-align-page">{hint}</span>}
			</span>
			{children}
		</div>
	);
}

/** The existing Agent/Appearance collapsed-menu look, shared with dictation.
 * `unavailable` preserves callers that gate clicks without native disabling;
 * `disabled` retains native button semantics where the caller requires them. */
export function SettingsMenuTrigger({
	value, unavailable, disabled, className, ...props
}: Omit<ComponentPropsWithRef<"button">, "value" | "children"> & {
	value: string;
	unavailable?: boolean;
}) {
	return <button
		type="button"
		{...props}
		disabled={disabled}
		className={cn(
			"flex h-8 items-center gap-1.5 rounded-lg border border-input bg-background px-3 font-ui text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
			disabled || unavailable ? "cursor-not-allowed" : "hover:border-muted-foreground/50",
			className,
		)}
	>
		<span dir={textDirection(value)} className="min-w-0 flex-1 truncate lh-align-page">{value}</span>
		<span aria-hidden className="text-muted-foreground">▾</span>
	</button>;
}

/** The on/off switch — a plain button in the switch role. */
export function Toggle({
	checked,
	disabled,
	onChange,
	label,
	discIcon,
	title,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name for the switch role. */
	label: string;
	/** Optional icon disc (owner round, 2026-10-07): the figure cards' invert
	 *  toggle renders the half-filled contrast circle AS the disc — the icon
	 *  carries the meaning; plain toggles keep the plain disc. */
	discIcon?: ReactNode;
	/** Optional native tooltip on the switch. */
	title?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			{...(title ? { title } : {})}
			disabled={disabled}
			data-testid={`toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-5 w-9 shrink-0 rounded-full ring-1 ring-inset ring-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
				// ON = amber primary track, white thumb with a soft shadow; OFF = the
				// muted track (ring-inset hairline keeps it legible in light theme).
				checked ? "bg-primary" : "bg-muted",
				disabled && "cursor-not-allowed",
			)}
		>
			{discIcon ? (
				// The icon IS the disc: same size, same slide, same state colors —
				// only the knob's face changes (the invert affordance).
				<span
					className={cn(
						"absolute inset-s-0 top-0.5 flex size-4 items-center justify-center rounded-full transition-transform motion-reduce:transition-none",
						checked ? "translate-x-4.5 rtl:-translate-x-4.5 text-primary-foreground" : "translate-x-0.5 rtl:-translate-x-0.5 text-muted-foreground",
					)}
				>
					{discIcon}
				</span>
			) : (
				<span
					className={cn(
						"absolute inset-s-0 top-0.5 size-4 rounded-full bg-white shadow-soft transition-transform motion-reduce:transition-none",
						// 2px inset from each inner edge, both states.
						checked ? "translate-x-4.5 rtl:-translate-x-4.5" : "translate-x-0.5 rtl:-translate-x-0.5",
					)}
				/>
			)}
		</button>
	);
}

/** A thin select — native element, options as given. */
export function ThinSelect({
	value,
	onChange,
	children,
	ariaLabel,
	testid,
	disabled,
}: {
	value: string;
	onChange: (next: string) => void;
	children: React.ReactNode;
	ariaLabel: string;
	testid?: string;
	disabled?: boolean;
}) {
	return (
		<select
			value={value}
			aria-label={ariaLabel}
			data-testid={testid}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
			className={cn(
				"h-8 rounded-lg border border-input bg-background px-3 font-ui text-sm text-foreground outline-none transition-colors hover:border-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring",
				disabled && "cursor-not-allowed",
			)}
		>
			{children}
		</select>
	);
}

/** A thin hex/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
	disabled,
}: {
	/** "" = unset (the factory default). Mirrors the STORED record —
	 *  after a clamped/normalized commit this flows back and the field
	 *  snaps to the stored truth (owner repro: a negative size kept
	 *  displaying "-5" while 12 was stored). */
	value: string;
	placeholder?: string;
	onCommit: (next: string) => void;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
	disabled?: boolean;
}) {
	// The draft exists only while editing; a blur shows the record's value
	// again — commit-on-blur/Enter (owner ruling), the field honest about
	// what landed.
	const [draft, setDraft] = useState(value);
	const [editing, setEditing] = useState(false);
	return (
		<input
			type={type}
			dir="ltr"
			value={editing ? draft : value}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			onChange={(e) => {
				setEditing(true);
				setDraft(e.target.value);
			}}
			onBlur={() => {
				if (!editing) return;
				setEditing(false);
				const next = draft.trim();
				if (next !== value) onCommit(next);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setEditing(false);
					e.currentTarget.blur();
				}
			}}
			disabled={disabled}
			className={cn(
				"h-8 w-40 rounded-lg border border-input bg-background px-3 font-ui text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 hover:border-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring",
				disabled && "cursor-not-allowed",
			)}
		/>
	);
}
