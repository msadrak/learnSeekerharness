"use client";

import { useCallback, useRef, useState } from "react";
import { BookOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { useEnterSubmits } from "@/components/enter-submits";
import { PathInput } from "@/components/path-input";
import { MessageResponse } from "@/components/ai-elements/message";
import { useT } from "@/components/i18n";
import { cn } from "@/lib/utils";
import { inputDirection, textDirection } from "@/lib/i18n/direction";
import type { AssignReadingInput, ReadingAnswerData } from "@/src/core";

/**
 * The reading dock — a pending assign_reading REPLACES the chat composer
 * like a question does: what to read (document, page range or highlighted
 * passage), what to look for, an optional note field (typed or dictated),
 * Go to passage and Done reading. Esc / skip dismissal is owned by the chat
 * view (the same one-Esc law as questions); this component is content only.
 */

export interface ReadingDockProps {
	input: AssignReadingInput;
	/** The document's display name (resolved by the caller from the viewer state). */
	documentName: string;
	/** Reveal the assigned passage / pages in the viewer. */
	onGo: () => void;
	onSubmit: (answer: ReadingAnswerData) => void;
	disabled?: boolean;
}

export function ReadingDock({ input, documentName, onGo, onSubmit, disabled = false }: ReadingDockProps) {
	const t = useT();
	const r = t.cards.documents.reading;
	const [note, setNote] = useState("");
	// The ref mirrors the field: dictation finals land via setState after an
	// await, and submit must read the tail (same law as QuestionDock).
	const noteRef = useRef("");

	// Dictated speech lands here while the reading waits (the composer is hidden).
	useDictationTarget(
		useCallback((text: string) => {
			const joined = joinDictation(noteRef.current, text);
			noteRef.current = joined;
			setNote(joined);
		}, []),
		true,
	);

	const doSubmit = () => {
		const trimmed = noteRef.current.trim();
		onSubmit({
			kind: "reading",
			done: true,
			...(trimmed ? { note: trimmed } : {}),
			answeredAt: new Date().toISOString(),
		});
	};
	const submit = () => {
		if (disabled) return;
		if (!isDictationActive()) {
			doSubmit();
			return;
		}
		void finishDictation().then(doSubmit);
	};
	// Enter submits from anywhere outside a typing surface (dictation never focuses the field).
	useEnterSubmits(submit);

	const locus =
		input.page !== undefined
			? input.endPage !== undefined && input.endPage > input.page
				? t.chat.viewer.pages(input.page, input.endPage)
				: t.chat.viewer.page(input.page)
			: r.highlighted;

	return (
		<div data-testid="reading-dock">
			<div data-dock-scroll-area="" className="max-h-[var(--dock-max-h,55dvh)] overflow-y-auto px-4 pt-3">
				<div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					<BookOpenIcon aria-hidden="true" className="size-3.5 shrink-0" />
					<span>{r.title}</span>
				</div>
				<div className="mb-2 flex flex-wrap items-baseline gap-x-1.5 font-medium">
					<bdi dir={textDirection(documentName)}>{documentName}</bdi>
					<span className="text-muted-foreground">·</span>
					<span className="text-sm text-muted-foreground">{locus}</span>
				</div>
				<div className="mb-3 text-sm">
					<MessageResponse>{input.instruction}</MessageResponse>
				</div>
			</div>
			<form
				className="border-t border-border p-2"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div
					data-testid="reading-note-field"
					className="rounded-lg border border-border bg-background/60 transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/30"
				>
					<PathInput
						value={note}
						dir={inputDirection(note)}
						onValueChange={(value) => {
							noteRef.current = value;
							setNote(value);
						}}
						onKeyDown={(e) => {
							// The standard chord: Enter submits, Shift+Enter is a newline,
							// ⌘/Ctrl+Enter submits too. Esc is not claimed here: the chat
							// view's window chain dismisses the reading.
							if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								submit();
							}
						}}
						placeholder={r.notePlaceholder}
						className={cn(
							"field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70",
						)}
					/>
					<div className="flex items-center justify-between gap-2 p-1">
						<Button type="button" variant="outline" className="h-9 rounded-lg px-4 text-sm font-medium" onClick={onGo}>
							{r.go}
						</Button>
						<Button
							type="submit"
							disabled={disabled}
							className="ms-auto h-9 rounded-lg px-4 text-sm font-medium"
						>
							{r.done}
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}

/** The finished assign_reading call in the transcript: "Done reading" + the
 *  learner's note, or "Skipped". `input` (the call's arguments) is optional
 *  context: the assignment's instruction is not repeated, only the outcome. */
export function ReadingCompletedCard({ answer }: { answer: ReadingAnswerData; input?: AssignReadingInput }) {
	const t = useT();
	const r = t.cards.documents.reading;
	if (answer.dismissed || !answer.done) {
		return (
			<div
				data-testid="reading-completed-card"
				className="my-2 flex items-center gap-2 rounded-xl border bg-card px-4 py-2.5 text-sm text-muted-foreground shadow-soft"
			>
				<BookOpenIcon aria-hidden="true" className="size-4 shrink-0" />
				{r.skipped}
			</div>
		);
	}
	return (
		<div data-testid="reading-completed-card" className="my-2 space-y-1.5 rounded-xl border bg-card px-4 py-2.5 text-sm shadow-soft">
			<div className="flex items-center gap-2 font-medium">
				<BookOpenIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
				{r.completed}
			</div>
			{answer.note && (
				<div dir={textDirection(answer.note)} className="whitespace-pre-wrap break-words text-muted-foreground">
					{answer.note}
				</div>
			)}
		</div>
	);
}
