"use client";

import { useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import type { DocumentAnnotation } from "@/src/core";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n";
import { textDirection } from "@/lib/i18n/direction";
import { boundingRegion } from "./region-geometry";
import { useDocumentViewer } from "./viewer-context";

const SNIPPET_CHARS = 90;

function snippet(quote: string): string {
	const flat = quote.replace(/\s+/g, " ").trim();
	return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

/** The active document's annotation proposals: pending (accept / reject), failed (with the reason), written (collapsed). */
export function AnnotationStrip({ documentId }: { documentId: string }) {
	const t = useT();
	const a = t.chat.viewer.annotations;
	const viewer = useDocumentViewer();
	const [busy, setBusy] = useState(false);
	if (!viewer) return null;

	const mine = viewer.state.annotations.filter((ann) => ann.documentId === documentId);
	const pending = mine.filter((ann) => ann.status === "pending");
	const failed = mine.filter((ann) => ann.status === "failed");
	const written = mine.filter((ann) => ann.status === "accepted");
	if (pending.length + failed.length + written.length === 0) return null;

	const decide = async (ids: string[], decision: "accept" | "reject") => {
		setBusy(true);
		try {
			await viewer.decide(ids, decision);
		} finally {
			setBusy(false);
		}
	};
	const reveal = (ann: DocumentAnnotation) =>
		viewer.reveal({ documentId, quote: ann.quote, page: ann.page, ...(ann.regions ? { region: boundingRegion(ann.regions) } : {}) });

	const quoteButton = (ann: DocumentAnnotation) => (
		<button
			type="button"
			onClick={() => reveal(ann)}
			className="min-w-0 flex-1 rounded-md px-1.5 py-1 text-start transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
		>
			<span dir={textDirection(ann.quote)} className="line-clamp-2 block text-xs text-foreground">
				{ann.page ? <span className="me-1 text-muted-foreground">{t.chat.viewer.page(ann.page)}</span> : null}
				{snippet(ann.quote)}
			</span>
			<span dir={textDirection(ann.note)} className="line-clamp-2 mt-0.5 block text-xs text-muted-foreground">
				{ann.note}
			</span>
		</button>
	);

	return (
		<section
			aria-label={a.title}
			data-testid="annotation-strip"
			className="max-h-[40%] shrink-0 overflow-auto border-t bg-card text-card-foreground"
		>
			{pending.length > 0 && (
				<div className="p-2">
					<div className="mb-1 flex items-center justify-between gap-2 px-1.5">
						<h3 className="font-ui text-xs font-medium text-warning">{a.pending(pending.length)}</h3>
						<Button
							type="button"
							size="xs"
							variant="outline"
							disabled={busy}
							onClick={() => void decide(pending.map((ann) => ann.id), "accept")}
						>
							<CheckIcon aria-hidden="true" />
							{a.acceptAll(pending.length)}
						</Button>
					</div>
					<ul className="flex flex-col gap-0.5">
						{pending.map((ann) => (
							<li key={ann.id} className="flex items-start gap-1">
								{quoteButton(ann)}
								<div className="flex shrink-0 items-center gap-1 pt-1">
									<Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => void decide([ann.id], "accept")}>
										{a.accept}
									</Button>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										disabled={busy}
										aria-label={a.reject}
										title={a.reject}
										onClick={() => void decide([ann.id], "reject")}
									>
										<XIcon aria-hidden="true" />
									</Button>
								</div>
								{ann.lastError ? <p className="basis-full ps-1.5 text-xs text-warning">{ann.lastError}</p> : null}
							</li>
						))}
					</ul>
				</div>
			)}
			{failed.length > 0 && (
				<ul className="flex flex-col gap-0.5 border-t p-2 first:border-t-0">
					{failed.map((ann) => (
						<li key={ann.id} className="flex flex-col">
							{quoteButton(ann)}
							<p className="px-1.5 text-xs text-danger">{a.failed[ann.failure ?? "not-found"]}</p>
						</li>
					))}
				</ul>
			)}
			{written.length > 0 && (
				<details className="border-t p-2 first:border-t-0">
					<summary className="cursor-pointer px-1.5 font-ui text-xs font-medium text-muted-foreground">{a.written(written.length)}</summary>
					<ul className="mt-1 flex flex-col gap-0.5">
						{written.map((ann) => (
							<li key={ann.id} className="flex items-start">
								{quoteButton(ann)}
							</li>
						))}
					</ul>
				</details>
			)}
		</section>
	);
}
