"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import type { ChatDeleteMode, ChatListItem } from "@/src/core";
import { useT } from "@/components/i18n";
import { textDirection } from "@/lib/i18n/direction";
import { localizeServerError } from "@/lib/i18n/server-errors";

type SessionRef = Pick<ChatListItem, "id" | "title">;

export interface BulkDeleteFailure {
	id: string;
	code: string;
	/** The server's own line, when it sent one. */
	error?: string;
	/** HTTP status when the server answered but refused. */
	status?: number;
}

export interface BulkDeleteResult {
	deleted: string[];
	failed: BulkDeleteFailure[];
	/** The newest graph revision any successful delete reported (0 = none). */
	graphRevision: number;
}

/**
 * Delete sessions ONE BY ONE through the single-session route (the server
 * gates — running turn/jobs, extraction winding down — are per session, so a
 * bulk request would be all-or-nothing). Failures never stop the run: the
 * rest still go, and every failure is reported so the UI can keep those
 * sessions selected and offer a retry.
 */
export async function runBulkDelete(
	ids: readonly string[],
	mode: ChatDeleteMode,
	onProgress?: (done: number, total: number) => void,
	request: typeof fetch = fetch,
): Promise<BulkDeleteResult> {
	const result: BulkDeleteResult = { deleted: [], failed: [], graphRevision: 0 };
	for (const [index, id] of ids.entries()) {
		try {
			const res = await request(`/api/chats/${id}?mode=${mode}`, { method: "DELETE" });
			const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; graphRevision?: number };
			if (res.ok) {
				result.deleted.push(id);
				result.graphRevision = Math.max(result.graphRevision, body.graphRevision ?? 0);
			} else {
				result.failed.push({ id, code: body.code ?? "error", error: body.error, status: res.status });
			}
		} catch {
			result.failed.push({ id, code: "network" });
		}
		onProgress?.(index + 1, ids.length);
	}
	return result;
}

/**
 * Bulk session deletion — the single-delete dialog's design for N sessions:
 * the same unchecked-by-default "also remove graph traces" checkbox (applied
 * to every session), Cancel + destructive Delete. Sessions that could not be
 * deleted stay listed with the server's reason and a Try again; the ones that
 * went are reported to the parent immediately (`onDeleted`).
 */
export function BulkDeleteSessionsDialog({
	chats,
	onClose,
	onDeleted,
}: {
	/** The sessions up for deletion; null = closed. */
	chats: readonly SessionRef[] | null;
	onClose: () => void;
	/** Called after each run with what was removed (the parent patches its list
	 *  and shrinks `chats` to the failures). */
	onDeleted: (result: BulkDeleteResult) => void;
}) {
	const t = useT();
	const [traces, setTraces] = useState(false);
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	const [failures, setFailures] = useState<BulkDeleteFailure[]>([]);
	const [attempted, setAttempted] = useState(0);
	const busy = progress !== null;
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});

	useEffect(() => {
		if (!chats) {
			setTraces(false);
			setProgress(null);
			setFailures([]);
			setAttempted(0);
		}
	}, [chats]);

	useEffect(() => {
		if (!chats) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				if (!busy) onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [chats, busy, onClose]);

	const run = async () => {
		if (!chats || busy || chats.length === 0) return;
		setFailures([]);
		setAttempted(chats.length);
		setProgress({ done: 0, total: chats.length });
		const result = await runBulkDelete(
			chats.map((c) => c.id),
			traces ? "delete-nodes" : "preserve-graph",
			(done, total) => setProgress({ done, total }),
		);
		setProgress(null);
		setFailures(result.failed);
		setAttempted(result.deleted.length + result.failed.length);
		onDeleted(result);
	};

	if (!chats) return null;
	const titles = new Map(chats.map((c) => [c.id, c.title]));
	// A fixed list of sessions can still shrink between runs (the parent drops
	// the deleted ones); failures for ids no longer listed are stale.
	const rows = failures
		.filter((f) => titles.has(f.id))
		.map((f) => ({
			id: f.id,
			title: titles.get(f.id) ?? f.id,
			message:
				f.error !== undefined
					? localizeServerError(f.error, t)
					: f.code === "network"
						? t.shell.deleteSession.failedNetwork
						: t.shell.deleteSession.failedStatus(f.status ?? 0),
		}));

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
			{...backdropDismiss}
		>
			<BulkDeleteBody
				chats={chats}
				traces={traces}
				progress={progress}
				failures={rows}
				attempted={attempted}
				onTraces={setTraces}
				onClose={onClose}
				onRun={() => void run()}
			/>
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for SSR pins (same pattern as
 *  DeleteSessionBody). The wrapper owns state, effects and the portal. */
export function BulkDeleteBody({
	chats,
	traces,
	progress,
	failures,
	attempted,
	onTraces,
	onClose,
	onRun,
}: {
	chats: readonly SessionRef[];
	traces: boolean;
	progress: { done: number; total: number } | null;
	failures: ReadonlyArray<{ id: string; title: string; message: string }>;
	/** How many sessions the last run tried (the partial-failure line's total). */
	attempted: number;
	onTraces: (next: boolean) => void;
	onClose: () => void;
	onRun: () => void;
}) {
	const t = useT();
	const s = t.shell.deleteSessions;
	const busy = progress !== null;
	const MAX_LISTED = 6;
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={s.ariaLabel}
			data-testid="bulk-delete-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-float"
		>
			<h2 className="text-sm font-semibold text-destructive">{s.title(chats.length)}</h2>
			<ul data-testid="bulk-delete-list" className="mt-2 max-h-32 space-y-0.5 overflow-y-auto">
				{chats.slice(0, MAX_LISTED).map((c) => (
					<li key={c.id} dir={textDirection(c.title)} className="truncate text-sm text-foreground">
						{c.title}
					</li>
				))}
				{chats.length > MAX_LISTED && (
					<li className="text-xs text-muted-foreground">{s.more(chats.length - MAX_LISTED)}</li>
				)}
			</ul>
			<p className="mt-2 text-sm text-muted-foreground">{s.description}</p>
			<label
				data-testid="bulk-delete-traces"
				className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-4 py-3 transition-colors hover:bg-accent/50"
			>
				<input
					type="checkbox"
					data-testid="bulk-delete-traces-checkbox"
					checked={traces}
					onChange={(e) => onTraces(e.target.checked)}
					disabled={busy}
					className="mt-0.5 size-4 shrink-0 accent-primary"
				/>
				<span className="min-w-0">
					<span className="block text-sm text-foreground">{s.tracesTitle}</span>
					<span className="mt-1 block text-xs text-muted-foreground">{s.tracesBody}</span>
				</span>
			</label>
			{failures.length > 0 && (
				<div role="alert" data-testid="bulk-delete-failure" className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
					<p className="text-foreground">{s.partialFailure(failures.length, attempted)}</p>
					<ul className="mt-1 space-y-0.5">
						{failures.map((f) => (
							<li key={f.id} className="text-muted-foreground">
								<span dir={textDirection(f.title)} className="text-foreground">{f.title}</span>
								{" — "}
								<span dir={textDirection(f.message)}>{f.message}</span>
							</li>
						))}
					</ul>
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="bulk-delete-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-lg px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-40"
				>
					{t.common.actions.cancel}
				</button>
				<button
					type="button"
					data-testid="bulk-delete-confirm"
					onClick={onRun}
					disabled={busy || chats.length === 0}
					className="rounded-lg bg-destructive px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-destructive/90 disabled:opacity-40"
				>
					{progress ? s.deleting(progress.done, progress.total) : failures.length > 0 ? t.shell.deleteSession.tryAgain : t.common.actions.delete}
				</button>
			</div>
		</div>
	);
}
