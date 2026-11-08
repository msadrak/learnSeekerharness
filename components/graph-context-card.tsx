"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/components/i18n";
import { textDirection } from "@/lib/i18n/direction";

/**
 * The graph-context card (owner, 2026-10-04): the session's map pick —
 * message[0] of a session started with propositions picked from the
 * graph. Scaffolding, not a turn: minimal, muted, collapsed by default;
 * expand reveals the picked propositions (name — statement) and the
 * reasoning chains among them (premises → conclusion lines). The model
 * reads the same content through the marker's own text (toLlmMessages);
 * this card is the learner's face of it.
 */

/** The graph-context marker's details (native-messages.ts). */
export interface GraphContextData {
	propositions: { id: string; name: string; statement: string }[];
	chains: string[];
}

export function GraphContextCard({ data }: { data: GraphContextData }) {
	const [open, setOpen] = useState(false);
	const { propositions = [], chains = [] } = data ?? {};
	const t = useT();
	const g = t.graph.contextCard;
	return (
		<div data-testid="graph-context-card" className="my-2">
			<button
				type="button"
				data-testid="graph-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-xl border bg-card px-4 py-2.5 text-start text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open ? "rotate-90" : "rtl:-scale-x-100")} />
				<span className="font-medium">{g.title}</span>
				<span className="min-w-0 flex-1 truncate">
					{g.propositions(propositions.length)}
					{chains.length > 0 ? ` · ${g.chains(chains.length)}` : ""}
				</span>
			</button>
			{open && (
				<div data-testid="graph-context-body" className="mt-1.5 space-y-1 rounded-xl border bg-card px-4 py-3 text-xs">
					{propositions.map((p) => (
						<div key={p.id} dir={textDirection(`${p.name}${p.statement}`)} data-testid={`graph-context-prop-${p.id}`} className="leading-relaxed">
							<span className="font-medium text-foreground/80">{p.name}</span>
							<span className="text-muted-foreground"> — {p.statement}</span>
						</div>
					))}
					{chains.length > 0 && (
						<div className="pt-1">
							{chains.map((c, i) => (
								<div key={i} dir={textDirection(c)} className="font-mono text-[11px] text-muted-foreground">
									{c}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
