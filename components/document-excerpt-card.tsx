"use client";

import { useEffect, useRef, useState } from "react";
import { useImageSnapshot } from "@/components/artifacts/use-image-snapshot";
import { PassageChip, PassageQuote } from "@/components/document-viewer/passage-parts";
import { sendBlockedReason } from "@/components/document-viewer/region-shared";
import { useDocumentViewer } from "@/components/document-viewer/viewer-context";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { inputDirection, textDirection } from "@/lib/i18n/direction";
import { MAX_EXCERPT_CHARS, type DocumentExcerpt } from "@/src/core";

/**
 * The learner's selected passage(s) from the document viewer — the user-side
 * card of a `document-excerpt` marker (Explain / Quiz me / Quote in message).
 * The model reads the marker's own content; this card shows the learner what
 * was sent: the action ("Explain this passage" / "Quiz me on this passage")
 * or his own typed text, and each quote as a block with a chip that jumps the
 * viewer back to the passage. A screenshot region of a scanned page also shows
 * its crop and the text the vision model read from it, and an explain / quiz
 * region can be corrected and sent again.
 */
export interface DocumentExcerptData {
	action: "explain" | "quiz" | "quote";
	excerpts: DocumentExcerpt[];
	text?: string;
}

function RegionThumb({ snapshotId, page }: { snapshotId: string; page?: number }) {
	const r = useT().chat.viewer.region;
	const { image } = useImageSnapshot(snapshotId);
	if (!image) return null;
	return (
		// eslint-disable-next-line @next/next/no-img-element -- a stored data-URI snapshot, not a routable asset
		<img
			src={`data:${image.mimeType};base64,${image.data}`}
			alt={page !== undefined ? r.cropAlt(page) : r.menuLabel}
			className="max-h-40 w-auto max-w-full rounded-md border bg-background object-contain"
		/>
	);
}

function ExcerptBlock({ excerpt, action }: { excerpt: DocumentExcerpt; action: DocumentExcerptData["action"] }) {
	const t = useT();
	const r = t.chat.viewer.region;
	const viewer = useDocumentViewer();
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(excerpt.quote);
	const editRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (editing) editRef.current?.focus();
	}, [editing]);

	const label = excerpt.page !== undefined ? `${excerpt.name} · ${t.chat.viewer.page(excerpt.page)}` : excerpt.name;
	const resendAction = action === "quote" ? null : action;
	const canResend = viewer !== null && excerpt.region !== undefined && resendAction !== null;
	const trimmed = text.trim();
	const blocked =
		text.length > MAX_EXCERPT_CHARS
			? r.tooLong
			: viewer
				? sendBlockedReason(viewer.selectionGate, t.chat.viewer.selection)
				: null;
	const disabled = blocked !== null || trimmed === "";

	return (
		<div className="space-y-1.5">
			{excerpt.region && excerpt.snapshotId && <RegionThumb snapshotId={excerpt.snapshotId} page={excerpt.page} />}
			{editing ? (
				<div className="space-y-1.5">
					<textarea
						ref={editRef}
						value={text}
						dir={inputDirection(text)}
						rows={5}
						aria-label={r.transcriptLabel}
						data-testid="excerpt-edit-text"
						onChange={(event) => setText(event.target.value)}
						className="w-full resize-y rounded-md border bg-background p-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
					/>
					{blocked && <p className="text-xs text-danger">{blocked}</p>}
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							data-testid="excerpt-edit-cancel"
							onClick={() => {
								setText(excerpt.quote);
								setEditing(false);
							}}
						>
							{r.cancel}
						</Button>
						<Button
							type="button"
							size="sm"
							data-testid="excerpt-resend"
							aria-disabled={disabled}
							title={blocked ?? undefined}
							className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
							onClick={() => {
								if (disabled || !viewer || !resendAction) return;
								void viewer.sendExcerpt(resendAction, { ...excerpt, quote: trimmed, corrected: true });
								setEditing(false);
							}}
						>
							{r[resendAction ?? "explain"]}
						</Button>
					</div>
				</div>
			) : (
				<PassageQuote quote={excerpt.quote} />
			)}
			<div className="flex flex-wrap items-center gap-1.5">
				<PassageChip
					label={label}
					title={label}
					onGo={
						viewer
							? () =>
									viewer.reveal({
										documentId: excerpt.documentId,
										quote: excerpt.region ? undefined : excerpt.quote,
										page: excerpt.page,
										occurrence: excerpt.occurrence,
										region: excerpt.region,
									})
							: undefined
					}
				/>
				{excerpt.corrected && (
					<span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">{r.corrected}</span>
				)}
				{canResend && !editing && (
					<button
						type="button"
						data-testid="excerpt-edit"
						onClick={() => setEditing(true)}
						className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{r.editResend}
					</button>
				)}
			</div>
		</div>
	);
}

export function DocumentExcerptCard({ data }: { data: DocumentExcerptData }) {
	const t = useT();
	const excerpts = Array.isArray(data?.excerpts) ? data.excerpts : [];
	const region = excerpts[0]?.region !== undefined;
	const headline =
		data?.action === "explain"
			? region
				? t.chat.viewer.region.explain
				: t.cards.documents.excerpt.explain
			: data?.action === "quiz"
				? region
					? t.chat.viewer.region.quiz
					: t.cards.documents.excerpt.quiz
				: typeof data?.text === "string" && data.text
					? data.text
					: null;
	return (
		<div
			data-testid="document-excerpt-card"
			className="my-2 w-full max-w-2xl space-y-2 rounded-xl border bg-card px-4 py-3 shadow-soft"
		>
			{headline && (
				<div dir={textDirection(headline)} className="whitespace-pre-wrap break-words text-sm font-medium">
					{headline}
				</div>
			)}
			{excerpts.map((excerpt, index) => (
				<ExcerptBlock key={index} excerpt={excerpt} action={data.action} />
			))}
		</div>
	);
}
