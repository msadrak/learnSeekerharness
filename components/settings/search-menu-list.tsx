"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { fuzzyScore } from "@/src/core";
import { Skeleton } from "@/components/ui/skeleton";

/** The model picker's search, arrow-walk, row styling and scrolling machine.
 * Models and dictation languages supply only their catalog and row content.
 * The caller owns the shared MenuShell and dismissal behavior. */
export function SearchMenuList<T>({
	items, itemKey, searchTerms, compare, prioritize, isSelected, onPick, renderItem,
	searchTestid, listTestid, optionTestid, placeholder, ariaLabel, loading, empty,
	disabled = false, sections, renderTrailing,
}: {
	items: readonly T[] | undefined;
	itemKey: (item: T) => string;
	searchTerms: (item: T) => string[];
	compare?: (a: T, b: T) => number;
	/** Optional grouping key: items it answers true for sort ahead of the
	 *  rest, fuzzy rank still deciding within each group (a stable partition,
	 *  never a filter — nothing is hidden). */
	prioritize?: (item: T) => boolean;
	isSelected: (item: T) => boolean;
	onPick: (item: T) => void;
	renderItem: (item: T) => ReactNode;
	searchTestid: string;
	listTestid: string;
	optionTestid: (item: T) => string;
	placeholder: string;
	ariaLabel?: string;
	loading?: string;
	empty: string;
	disabled?: boolean;
	/** Grouped layout for the blank-query state: the flattened sections, in
	 *  order, ARE the list (arrow/Enter indices index into it). A non-blank
	 *  query falls back to the flat ranked list. */
	sections?: (results: readonly T[]) => Array<{ key: string; label: string; items: T[] }>;
	/** Rendered as a sibling after the option button inside its row. */
	renderTrailing?: (item: T) => ReactNode;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => { searchRef.current?.focus(); }, []);
	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const results = (items ?? [])
		.map((item) => ({ item, score: fuzzyScore(query, ...searchTerms(item)) }))
		.filter((result) => result.score !== null)
		.sort(
			(a, b) =>
				(prioritize ? Number(prioritize(b.item)) - Number(prioritize(a.item)) : 0) ||
				b.score! - a.score! ||
				(compare?.(a.item, b.item) ?? 0),
		)
		.map(({ item }) => item);

	const grouped = sections && query.trim() === "" ? sections(results) : null;
	const flat = grouped ? grouped.flatMap((section) => section.items) : results;

	return <>
		<input
			type="text"
			ref={searchRef}
			data-testid={searchTestid}
			aria-label={ariaLabel}
			value={query}
			disabled={disabled}
			onChange={(event) => { setQuery(event.target.value); setMenuIdx(null); }}
			onKeyDown={(event) => {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					event.stopPropagation();
					if (disabled || flat.length === 0) return;
					setMenuIdx((i) => event.key === "ArrowDown"
						? Math.min((i ?? -1) + 1, flat.length - 1)
						: Math.max((i ?? flat.length) - 1, 0));
				} else if (event.key === "Enter") {
					const chosen = flat[menuIdx ?? 0];
					if (!disabled && chosen !== undefined) {
						event.preventDefault();
						event.stopPropagation();
						onPick(chosen);
					}
				}
			}}
			placeholder={placeholder}
			className="lh-input mb-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
		/>
		{!items && loading && <div>
			{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="mx-2 my-1 h-8" />)}
			<span className="sr-only">{loading}</span>
		</div>}
		{items && flat.length === 0 && <div className="px-2 py-3 text-center text-muted-foreground">{empty}</div>}
		<ul ref={listRef} data-testid={listTestid} className="flex max-h-72 flex-col overflow-y-auto px-1">
			{(grouped ?? [{ key: "", label: "", items: results }]).map((section, s, all) => {
				const offset = all.slice(0, s).reduce((n, prev) => n + prev.items.length, 0);
				return <Fragment key={section.key}>
					{grouped && section.items.length > 0 && <li
						role="presentation"
						data-testid={`menu-group-${section.key}`}
						className="px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground"
					>{section.label}</li>}
					{section.items.map((item, j) => {
						const i = offset + j;
						return <li key={itemKey(item)} className="flex items-center">
							<button
								type="button"
								data-testid={optionTestid(item)}
								data-idx={i}
								disabled={disabled}
								onClick={() => onPick(item)}
								className={`flex w-full flex-1 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-start outline-none transition-colors hover:bg-accent ${
									i === menuIdx ? "bg-accent" : ""
								}${isSelected(item) && i !== menuIdx ? " bg-primary/10" : ""}`}
							>{renderItem(item)}</button>
							{renderTrailing?.(item)}
						</li>;
					})}
				</Fragment>;
			})}
		</ul>
	</>;
}
