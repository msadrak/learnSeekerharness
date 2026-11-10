"use client";

import { FileTextIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { textDirection } from "@/lib/i18n/direction";

/** A passage quote as a block: rail on the inline start, clamped to 4 lines,
 *  direction from the text itself (never dir="auto"). */
export function PassageQuote({ quote, className }: { quote: string; className?: string }) {
	return (
		<blockquote
			dir={textDirection(quote)}
			className={cn(
				"line-clamp-4 whitespace-pre-wrap break-words border-s-2 border-border ps-3 text-sm leading-relaxed text-foreground/80",
				className,
			)}
		>
			{quote}
		</blockquote>
	);
}

/** The chip that jumps the viewer back to a passage. Without a viewer
 *  (surfaces outside Chat) it is a plain label. */
export function PassageChip({ label, title, onGo }: { label: string; title?: string; onGo?: () => void }) {
	const body = (
		<>
			<FileTextIcon aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="min-w-0 truncate">{label}</span>
		</>
	);
	const base = "inline-flex max-w-full items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 align-middle text-xs";
	if (!onGo) return <span className={base}>{body}</span>;
	return (
		<button
			type="button"
			title={title ?? label}
			onClick={onGo}
			className={cn(base, "cursor-pointer transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
		>
			{body}
		</button>
	);
}
