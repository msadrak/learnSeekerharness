"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useT } from "@/components/i18n";

/**
 * The ESC-abort guard (owner, 2026-10-02): the global Esc → abort chain
 * opens this confirm popup EVERYWHERE — mid-stream aborts and pending-
 * question dismissals alike. Esc on the popup itself cancels (claimed —
 * it must never chain into another abort), which is also why Chat's
 * abort handler ignores events while this dialog is open: two window
 * listeners fire per Esc and stopPropagation alone cannot order them.
 *
 * MINIMAL, the delete-node dialog's tone: title, one line, Cancel +
 * action. No busy state — both actions are local (a fetch that fires
 * and forgets, an answer submit whose own machinery shows progress).
 *
 * What "abort" means is mode-dependent: from a running turn it kills
 * the turn (partial stays); from a pending question there is no turn to
 * kill — abort IS dismissal (A2, 2026-10-03): the silent route writes
 * the skipped toolResult and wakes NOTHING; the session pauses until
 * the user's next plain message, which carries the dismissal to the
 * model in its context.
 */

/** What Esc is aborting — drives copy and the confirm action. */
export type AbortMode = "turn" | "question" | "problem";
/** The dialog's pure body — exported for SSR pins (the delete-node
 * pattern). The wrapper owns effects + the portal. */
export function AbortTurnBody({
	mode,
	onClose,
	onConfirm,
	busy = false,
}: {
	mode: AbortMode;
	onClose: () => void;
	onConfirm: () => void;
	/** The dismiss doubles as the abort when a turn is still running
	 * (owner, 2026-10-04): the line says so. */
	busy?: boolean;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	const t = useT();
	const copy = t.chat.abort[mode];
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={copy.title}
			data-testid="abort-turn-dialog"
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
			// A genuine click on the scrim cancels — the cautious default, like Esc.
			{...backdropDismiss}
		>
			<div
				className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-float"
				onClick={(e) => e.stopPropagation()}
			>
				<h2 className="text-sm font-semibold text-card-foreground" data-testid="abort-turn-title">
					{copy.title}
				</h2>
				<p className="mt-1.5 text-xs text-muted-foreground" data-testid="abort-turn-line">
					{copy.line}
					{busy && mode !== "turn" ? t.chat.abort.turnStopsToo : ""}
				</p>
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						data-testid="abort-turn-cancel"
						onClick={onClose}
						className="rounded-lg px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
					>
						{t.common.actions.cancel}
					</button>
					<button
						type="button"
						data-testid="abort-turn-confirm"
						onClick={onConfirm}
						// Destructive red — the app's established destructive pair.
						className="rounded-lg bg-destructive px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-destructive/90"
					>
						{copy.action}
					</button>
				</div>
			</div>
		</div>
	);
}

export function AbortTurnDialog({
	mode,
	onClose,
	onConfirm,
	busy = false,
}: {
	/** What Esc is aborting; null = closed (nothing rendered). */
	mode: AbortMode | null;
	onClose: () => void;
	onConfirm: (mode: AbortMode) => void;
	busy?: boolean;
}) {
	// Esc cancels the popup (claimed — never a chained abort).
	useEffect(() => {
		if (mode === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW (keyboard round 2026-10-06): claim at the
				// document level — a window-level stopPropagation cannot stop
				// the earlier-registered global window listener.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [mode, onClose]);

	if (mode === null || typeof document === "undefined") return null;
	return createPortal(
		<AbortTurnBody mode={mode} onClose={onClose} onConfirm={() => onConfirm(mode)} busy={busy} />,
		document.body,
	);
}
