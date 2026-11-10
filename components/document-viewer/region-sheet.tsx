"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import {
	MAX_EXCERPT_CHARS,
	MODELS_NOT_CONFIGURED_CODE,
	PROVIDER_KEY_MISSING_CODE,
	REGION_EMPTY_CODE,
	REGION_NO_IMAGE_INPUT_CODE,
} from "@/src/core";
import { useImageSnapshot } from "@/components/artifacts/use-image-snapshot";
import { useT, type Messages } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { inputDirection } from "@/lib/i18n/direction";
import type { RegionReadError } from "./region-api";
import { sendBlockedReason, type RegionAction } from "./region-shared";
import { useDocumentViewer } from "./viewer-context";

/** What the sheet shows: the model is reading, the learner checks the text, or the read failed. */
export type SheetState =
	| { kind: "reading" }
	| { kind: "review"; transcript: string; snapshotId: string }
	| { kind: "failed"; error: RegionReadError };

interface RegionSheetProps {
	state: SheetState;
	action: RegionAction;
	page: number;
	chatId: string;
	review: boolean;
	onReviewChange(value: boolean): void;
	onSubmit(text: string): void;
	onRetry(): void;
	onClose(): void;
}

function errorText(error: RegionReadError, r: Messages["chat"]["viewer"]["region"]): string {
	if (error.code === REGION_EMPTY_CODE) return r.empty;
	if (error.code === REGION_NO_IMAGE_INPUT_CODE) return r.noImageModel;
	return r.failed(error.message);
}

const SHEET = "absolute inset-x-2 bottom-2 z-30 rounded-xl border bg-popover p-3 font-ui shadow-float";

/**
 * The bottom sheet of the region tool: the reading status (cancellable), the
 * learner's check of the transcript (editable, with the action as its primary
 * button), or the failure with Try again. Lives inside the viewer body so the
 * page above stays scrollable while the text is checked.
 */
export function RegionSheet({ state, action, page, chatId, review, onReviewChange, onSubmit, onRetry, onClose }: RegionSheetProps) {
	const t = useT();
	const r = t.chat.viewer.region;
	const viewer = useDocumentViewer();

	if (state.kind === "reading") {
		return (
			<div role="status" data-testid="region-sheet" className={`${SHEET} flex items-center gap-2 text-sm`}>
				<LoaderCircleIcon aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
				<span className="min-w-0 flex-1">{r.reading}</span>
				<Button type="button" size="sm" variant="ghost" data-testid="region-cancel" onClick={onClose}>
					{r.cancel}
				</Button>
			</div>
		);
	}

	if (state.kind === "failed") {
		const { code } = state.error;
		const needsKey = code === PROVIDER_KEY_MISSING_CODE;
		const needsSetup = needsKey || code === MODELS_NOT_CONFIGURED_CODE || code === REGION_NO_IMAGE_INPUT_CODE;
		return (
			<div role="alert" data-testid="region-sheet" className={`${SHEET} space-y-2`}>
				<p className="text-sm text-danger">{errorText(state.error, r)}</p>
				<div className="flex flex-wrap justify-end gap-2">
					{needsSetup && viewer && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => {
								viewer.openSetup();
								onClose();
							}}
						>
							{needsKey ? t.cards.dispatch.addKey : t.cards.dispatch.setUpModels}
						</Button>
					)}
					{code !== REGION_NO_IMAGE_INPUT_CODE && code !== MODELS_NOT_CONFIGURED_CODE && code !== PROVIDER_KEY_MISSING_CODE && (
						<Button type="button" size="sm" variant="outline" data-testid="region-retry" onClick={onRetry}>
							{r.retry}
						</Button>
					)}
					<Button type="button" size="sm" variant="ghost" data-testid="region-close" onClick={onClose}>
						{r.close}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<ReviewBody
			key={state.snapshotId}
			transcript={state.transcript}
			snapshotId={state.snapshotId}
			action={action}
			page={page}
			chatId={chatId}
			review={review}
			onReviewChange={onReviewChange}
			onSubmit={onSubmit}
			onClose={onClose}
		/>
	);
}

function ReviewBody({
	transcript,
	snapshotId,
	action,
	page,
	chatId,
	review,
	onReviewChange,
	onSubmit,
	onClose,
}: {
	transcript: string;
	snapshotId: string;
	action: RegionAction;
	page: number;
	chatId: string;
	review: boolean;
	onReviewChange(value: boolean): void;
	onSubmit(text: string): void;
	onClose(): void;
}) {
	const t = useT();
	const r = t.chat.viewer.region;
	const viewer = useDocumentViewer();
	const snapshot = useImageSnapshot(snapshotId, chatId);
	const [text, setText] = useState(transcript);
	const textRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		textRef.current?.focus();
	}, []);

	const tooLong = text.length > MAX_EXCERPT_CHARS;
	const trimmed = text.trim();
	const blocked = tooLong
		? r.tooLong
		: action !== "quote" && viewer
			? sendBlockedReason(viewer.selectionGate, t.chat.viewer.selection)
			: null;
	const disabled = blocked !== null || trimmed === "";

	return (
		<section aria-label={r.reviewTitle} data-testid="region-sheet" className={`${SHEET} space-y-2`}>
			<h3 className="text-xs font-medium text-muted-foreground">{r.reviewTitle}</h3>
			<div className="flex gap-3">
				{snapshot.image && (
					// eslint-disable-next-line @next/next/no-img-element -- a stored data-URI snapshot, not a routable asset
					<img
						src={`data:${snapshot.image.mimeType};base64,${snapshot.image.data}`}
						alt={r.cropAlt(page)}
						className="max-h-32 w-auto max-w-[40%] shrink-0 self-start rounded-md border bg-background object-contain"
					/>
				)}
				<textarea
					ref={textRef}
					value={text}
					dir={inputDirection(text)}
					rows={6}
					aria-label={r.transcriptLabel}
					data-testid="region-text"
					onChange={(event) => setText(event.target.value)}
					className="min-h-24 min-w-0 flex-1 resize-y rounded-md border bg-background p-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
				/>
			</div>
			{tooLong && (
				<p role="alert" className="text-xs text-danger">
					{r.tooLong} ({text.length.toLocaleString("en-US")})
				</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
					<input
						type="checkbox"
						checked={review}
						data-testid="region-review-toggle"
						onChange={(event) => onReviewChange(event.target.checked)}
						className="size-3.5 accent-brand"
					/>
					<span>{r.reviewToggle}</span>
				</label>
				<Button type="button" size="sm" variant="ghost" data-testid="region-cancel" onClick={onClose}>
					{r.cancel}
				</Button>
				<Button
					type="button"
					size="sm"
					data-testid="region-submit"
					aria-disabled={disabled}
					title={blocked ?? undefined}
					className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
					onClick={() => {
						if (!disabled) onSubmit(trimmed);
					}}
				>
					{r[action]}
				</Button>
			</div>
		</section>
	);
}
