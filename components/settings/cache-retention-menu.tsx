"use client";

import type { CacheRetention } from "@earendil-works/pi-ai";
import { useT } from "@/components/i18n";
import { en, type Messages } from "@/lib/i18n/messages";

type CacheCopy = Messages["settings"]["cacheRetention"];
type CacheText = { [K in keyof CacheCopy]: CacheCopy[K] extends string ? K : never }[keyof CacheCopy];

const OPTIONS = [
	{ value: undefined, compact: "compactDefault", label: "piDefault", description: "defaultDescription" },
	{ value: "none", compact: "compactNone", label: "none", description: "noneDescription" },
	{ value: "short", compact: "compactShort", label: "short", description: "shortDescription" },
	{ value: "long", compact: "compactLong", label: "long", description: "longDescription" },
] as const satisfies readonly { value: CacheRetention | undefined; compact: CacheText; label: CacheText; description: CacheText }[];

export function cacheRetentionLabel(value: CacheRetention | undefined, c: CacheCopy = en.settings.cacheRetention): string {
	return c.summary(c[OPTIONS.find((option) => option.value === value)!.compact]);
}

export function CacheRetentionMenu({ value, onPick }: {
	value: CacheRetention | undefined;
	onPick: (value: CacheRetention | undefined) => void;
}) {
	const c = useT().settings.cacheRetention;
	return <>
		<div className="border-b border-border px-2 pb-2">
			<p className="text-card-foreground">{c.title}</p>
			<p className="mt-1 text-muted-foreground">{c.description}</p>
		</div>
		{OPTIONS.map((option) => <button
			key={option.value ?? "default"}
			type="button"
			data-testid={`cache-retention-option-${option.value ?? "default"}`}
			aria-pressed={value === option.value}
			onClick={() => onPick(option.value)}
			className={`rounded-lg px-2 py-2 text-start transition-colors hover:bg-muted ${value === option.value ? "bg-muted/60" : ""}`}
		>
			<span className="flex justify-between gap-2 text-card-foreground"><span>{c[option.label]}</span>{value === option.value && <span aria-hidden>✓</span>}</span>
			<span className="mt-1 block text-muted-foreground">{c[option.description]}</span>
		</button>)}
	</>;
}
