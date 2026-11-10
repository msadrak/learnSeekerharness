"use client";

import { CropIcon, QuoteIcon, XIcon } from "lucide-react";
import { useDocumentViewer } from "@/components/document-viewer/viewer-context";
import { useT } from "@/components/i18n";
import { textDirection } from "@/lib/i18n/direction";

const PREVIEW_CHARS = 60;

/** The first characters of a quote, whitespace collapsed, ellipsis when cut. */
function preview(quote: string): string {
	const flat = quote.replace(/\s+/g, " ").trim();
	return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/** The passages attached to the next message (Quote in message): one
 *  removable chip each. Renders nothing without quotes (or outside Chat). */
export function QuoteTray() {
	const t = useT();
	const viewer = useDocumentViewer();
	if (!viewer || viewer.quotes.length === 0) return null;
	return (
		<div data-testid="quote-tray" className="flex flex-wrap gap-1.5 px-2 pb-1.5">
			{viewer.quotes.map((quote, index) => {
				const text = preview(quote.quote);
				return (
					<span
						key={index}
						data-testid="quote-chip"
						className="inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/50 py-1 ps-2 pe-1 text-xs"
					>
						{quote.region ? (
							<CropIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
						) : (
							<QuoteIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0 truncate">
							<bdi dir={textDirection(text)}>{`“${text}”`}</bdi>
							<span className="text-muted-foreground">
								{" · "}
								<bdi dir={textDirection(quote.name)}>{quote.name}</bdi>
								{quote.page !== undefined && ` ${t.chat.viewer.page(quote.page)}`}
							</span>
						</span>
						<button
							type="button"
							aria-label={t.chat.viewer.quotes.remove}
							title={t.chat.viewer.quotes.remove}
							onClick={() => viewer.removeQuote(index)}
							className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<XIcon aria-hidden="true" className="size-3" />
						</button>
					</span>
				);
			})}
		</div>
	);
}
