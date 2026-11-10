"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { documentFormatOf, emptyViewer, type ChatViewerState, type DocumentLocation } from "@/src/core";
import { MAX_DOCUMENT_BYTES } from "@/lib/document-limits";
import { useT } from "@/components/i18n";
import type { PendingReveal, RevealTarget, ViewerBanner, ViewerStateApi } from "./viewer-context";

/** Device preference (all sessions): panel open/closed and its width as a fraction of the session area. */
const STORAGE_KEY = "lh:document-viewer";
const DEFAULT_WIDTH = 0.45;
const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.85;
const LAYOUT_DEBOUNCE_MS = 400;

interface DevicePref {
	open: boolean;
	width: number;
}

function clampFraction(value: number): number {
	return Number.isFinite(value) ? Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value)) : DEFAULT_WIDTH;
}

function readPref(): DevicePref {
	const fallback = { open: false, width: DEFAULT_WIDTH };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Partial<DevicePref> | null;
		return {
			open: parsed?.open === true,
			width: typeof parsed?.width === "number" ? clampFraction(parsed.width) : DEFAULT_WIDTH,
		};
	} catch {
		return fallback;
	}
}

function writePref(pref: DevicePref): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
	} catch {
		// Storage unavailable (private mode / quota): the preference is session-only.
	}
}

function sameLocation(a: DocumentLocation | undefined, b: DocumentLocation): boolean {
	return a?.page === b.page && a?.section === b.section;
}

/** Keep `activeId` inside `tabs`. */
function normalized(viewer: ChatViewerState): ChatViewerState {
	const activeId = viewer.activeId !== null && viewer.tabs.includes(viewer.activeId) ? viewer.activeId : (viewer.tabs.at(-1) ?? null);
	return activeId === viewer.activeId ? viewer : { ...viewer, activeId };
}

/**
 * The viewer's client state: the session's `ChatViewerState` (tabs, active
 * document, positions, annotations — the server owns documents/annotations),
 * the device preference, the agent banner and the pending reveal.
 * Layout changes are PUT debounced; server pushes (tool cards, decisions)
 * merge without clobbering a layout change that has not been sent yet.
 */
export function useViewerState({
	chatId,
	initial,
	ignoreToolCallIds,
}: {
	chatId: string;
	initial: ChatViewerState | null;
	ignoreToolCallIds: ReadonlySet<string>;
}): ViewerStateApi {
	const t = useT();
	const v = t.chat.viewer;
	const [state, setState] = useState<ChatViewerState>(() => initial ?? emptyViewer());
	// Start closed/default so the server render and the first client render agree; storage is applied after mount.
	const [panelOpen, setPanelOpenState] = useState(false);
	const [width, setWidthState] = useState(DEFAULT_WIDTH);
	const [banner, setBanner] = useState<ViewerBanner | null>(null);
	const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(null);
	const [attention, setAttention] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Latest values for async callbacks (updated by the action functions themselves, never during render).
	const stateRef = useRef(state);
	const panelOpenRef = useRef(false);
	const widthRef = useRef(DEFAULT_WIDTH);
	const timerRef = useRef<number | null>(null);
	const inflightRef = useRef<Promise<void> | null>(null);
	const revealSeq = useRef(0);
	const announced = useRef(new Set<string>());
	const settled = useRef(new Set<string>());
	const vRef = useRef(v);
	useEffect(() => {
		vRef.current = v;
	}, [v]);

	const commit = useCallback((update: (viewer: ChatViewerState) => ChatViewerState) => {
		stateRef.current = update(stateRef.current);
		setState(stateRef.current);
	}, []);

	// ── layout persistence (PUT /viewer) ────────────────────────────────────

	const sendLayout = useCallback(
		(keepalive = false): Promise<void> => {
			const viewer = stateRef.current;
			const body = JSON.stringify({
				tabs: viewer.tabs,
				activeId: viewer.activeId,
				panelVisible: panelOpenRef.current,
				positions: viewer.positions,
			});
			const request = fetch(`/api/chats/${chatId}/viewer`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body,
				keepalive,
			})
				.then(async (res) => {
					// A rejected layout (e.g. a tab for a document the server does not know) resyncs from the server.
					if (!res.ok && timerRef.current === null) await refreshRef.current();
				})
				.catch(() => {})
				.finally(() => {
					if (inflightRef.current === request) inflightRef.current = null;
				});
			inflightRef.current = request;
			return request;
		},
		[chatId],
	);

	const schedulePut = useCallback(() => {
		if (stateRef.current.documents.length === 0) return;
		clearTimeout(timerRef.current ?? undefined);
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			void sendLayout();
		}, LAYOUT_DEBOUNCE_MS);
	}, [sendLayout]);

	const flush = useCallback(async (): Promise<void> => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
			await sendLayout();
			return;
		}
		await inflightRef.current;
	}, [sendLayout]);

	// ── server merge ────────────────────────────────────────────────────────

	/** Adopt a server viewer. Documents/annotations always come from the server; the layout
	 *  comes from it too unless a local layout change is still waiting to be sent. */
	const adopt = useCallback(
		(server: ChatViewerState) => {
			const dirty = timerRef.current !== null;
			commit((local) => {
				const known = new Set(local.documents.map((d) => d.id));
				const base = dirty
					? {
							...local,
							// Documents the agent registered meanwhile get their tab.
							tabs: [...local.tabs, ...server.tabs.filter((id) => !known.has(id) && !local.tabs.includes(id))],
						}
					: { ...local, tabs: server.tabs, activeId: server.activeId, positions: server.positions };
				return normalized({
					...base,
					documents: server.documents,
					annotations: server.annotations,
					reportedPosition: server.reportedPosition,
				});
			});
			if (server.panelVisible !== panelOpenRef.current && server.documents.length > 0) schedulePut();
		},
		[commit, schedulePut],
	);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const res = await fetch(`/api/chats/${chatId}/viewer`, { cache: "no-store" });
			if (!res.ok) return;
			const body = (await res.json()) as { viewer?: ChatViewerState };
			if (body.viewer) adopt(body.viewer);
		} catch {
			// Offline / server restarting: the next record-changed or tool card retries.
		}
	}, [adopt, chatId]);
	const refreshRef = useRef(refresh);
	useEffect(() => {
		refreshRef.current = refresh;
	}, [refresh]);

	// ── panel + device preference ───────────────────────────────────────────

	useEffect(() => {
		const pref = readPref();
		widthRef.current = pref.width;
		setWidthState(pref.width);
		if (pref.open) {
			panelOpenRef.current = true;
			setPanelOpenState(true);
			if (stateRef.current.panelVisible !== true) schedulePut();
		}
	}, [schedulePut]);

	// A pending layout change must not die with the page.
	useEffect(
		() => () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
				void sendLayout(true);
			}
		},
		[sendLayout],
	);

	const setPanelOpen = useCallback(
		(open: boolean) => {
			if (panelOpenRef.current === open) return;
			panelOpenRef.current = open;
			setPanelOpenState(open);
			if (open) setAttention(false);
			writePref({ open, width: widthRef.current });
			schedulePut();
		},
		[schedulePut],
	);

	const setWidth = useCallback((fraction: number) => {
		const next = clampFraction(fraction);
		if (widthRef.current === next) return;
		widthRef.current = next;
		setWidthState(next);
		writePref({ open: panelOpenRef.current, width: next });
	}, []);

	// ── tabs ────────────────────────────────────────────────────────────────

	const showDocument = useCallback(
		(id: string) => {
			commit((viewer) => ({ ...viewer, tabs: viewer.tabs.includes(id) ? viewer.tabs : [...viewer.tabs, id], activeId: id }));
			setPanelOpen(true);
			schedulePut();
		},
		[commit, schedulePut, setPanelOpen],
	);

	/** Make sure the client knows `id` (an agent may have just registered it), then show it. */
	const openDocument = useCallback(
		(id: string) => {
			if (stateRef.current.documents.some((d) => d.id === id)) {
				showDocument(id);
				return;
			}
			void refreshRef.current().then(() => showDocument(id));
		},
		[showDocument],
	);

	const closeTab = useCallback(
		(id: string) => {
			commit((viewer) => {
				const index = viewer.tabs.indexOf(id);
				if (index < 0) return viewer;
				const tabs = viewer.tabs.filter((tab) => tab !== id);
				const activeId = viewer.activeId === id ? (tabs[Math.min(index, tabs.length - 1)] ?? null) : viewer.activeId;
				return { ...viewer, tabs, activeId };
			});
			schedulePut();
		},
		[commit, schedulePut],
	);

	const setActive = useCallback(
		(id: string) => {
			if (stateRef.current.activeId === id) return;
			commit((viewer) => ({ ...viewer, tabs: viewer.tabs.includes(id) ? viewer.tabs : [...viewer.tabs, id], activeId: id }));
			schedulePut();
		},
		[commit, schedulePut],
	);

	const reportPosition = useCallback(
		(id: string, loc: DocumentLocation) => {
			const viewer = stateRef.current;
			if (!viewer.documents.some((d) => d.id === id) || sameLocation(viewer.positions[id], loc)) return;
			commit((current) => ({ ...current, positions: { ...current.positions, [id]: loc } }));
			schedulePut();
		},
		[commit, schedulePut],
	);

	// ── opening files ───────────────────────────────────────────────────────

	const fail = useCallback((message: string) => {
		setError(message);
		toast.error(message);
	}, []);

	const submit = useCallback(
		async (init: RequestInit, label: string): Promise<void> => {
			setError(null);
			let res: Response;
			try {
				res = await fetch(`/api/chats/${chatId}/documents`, init);
			} catch {
				fail(vRef.current.unreadable);
				return;
			}
			const body = (await res.json().catch(() => null)) as { viewer?: ChatViewerState; documentId?: string; error?: string; path?: string } | null;
			if (!res.ok || !body?.viewer || !body.documentId) {
				const text = vRef.current;
				if (res.status === 404) fail(text.missing(body?.path ?? label));
				else if (res.status === 403 && body?.error) fail(body.error);
				else if (res.status === 400) fail(text.unsupported);
				else if (res.status === 413) fail(text.tooLarge);
				else fail(text.unreadable);
				return;
			}
			adopt(body.viewer);
			showDocument(body.documentId);
		},
		[adopt, chatId, fail, showDocument],
	);

	const openPath = useCallback(
		async (path: string): Promise<void> => {
			if (documentFormatOf(path) === null) {
				fail(vRef.current.unsupported);
				return;
			}
			await submit({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }, path);
		},
		[fail, submit],
	);

	const upload = useCallback(
		async (file: File): Promise<void> => {
			if (documentFormatOf(file.name) === null) {
				fail(vRef.current.unsupported);
				return;
			}
			if (file.size > MAX_DOCUMENT_BYTES) {
				fail(vRef.current.tooLarge);
				return;
			}
			const form = new FormData();
			form.append("file", file);
			await submit({ method: "POST", body: form }, file.name);
		},
		[fail, submit],
	);

	// ── agent → learner ─────────────────────────────────────────────────────

	const reveal = useCallback(
		(target: RevealTarget) => {
			const request = () => {
				showDocument(target.documentId);
				revealSeq.current += 1;
				setPendingReveal({ seq: revealSeq.current, target });
			};
			if (stateRef.current.documents.some((d) => d.id === target.documentId)) request();
			else void refreshRef.current().then(request);
		},
		[showDocument],
	);

	const consumeReveal = useCallback((seq: number) => {
		setPendingReveal((current) => (current?.seq === seq ? null : current));
	}, []);

	const announce = useCallback(
		(toolCallId: string, target: RevealTarget, kind: "point" | "open") => {
			if (ignoreToolCallIds.has(toolCallId) || announced.current.has(toolCallId)) return;
			announced.current.add(toolCallId);
			setBanner({ toolCallId, target, kind });
			if (!panelOpenRef.current) setAttention(true);
		},
		[ignoreToolCallIds],
	);

	const toolSettled = useCallback(
		(toolCallId: string) => {
			if (ignoreToolCallIds.has(toolCallId) || settled.current.has(toolCallId)) return;
			settled.current.add(toolCallId);
			void refreshRef.current();
		},
		[ignoreToolCallIds],
	);

	const dismissBanner = useCallback(() => setBanner(null), []);

	const decide = useCallback(
		async (ids: string[], decision: "accept" | "reject"): Promise<void> => {
			if (ids.length === 0) return;
			try {
				const res = await fetch(`/api/chats/${chatId}/annotations`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ decision, ids }),
				});
				const body = (await res.json().catch(() => null)) as {
					viewer?: ChatViewerState;
					outcomes?: { id: string; outcome: "accepted" | "rejected" | "failed" | "pending"; message?: string }[];
					error?: string;
				} | null;
				if (!res.ok || !body?.viewer) {
					toast.error(body?.error ?? vRef.current.unreadable);
					return;
				}
				adopt(body.viewer);
				for (const outcome of body.outcomes ?? []) {
					if (outcome.outcome === "accepted" || outcome.outcome === "rejected" || !outcome.message) continue;
					toast.error(outcome.message);
				}
			} catch {
				toast.error(vRef.current.unreadable);
			}
		},
		[adopt, chatId],
	);

	const clearError = useCallback(() => setError(null), []);

	return useMemo<ViewerStateApi>(
		() => ({
			state,
			panelOpen,
			setPanelOpen,
			width,
			setWidth,
			banner,
			dismissBanner,
			openDocument,
			openPath,
			upload,
			closeTab,
			setActive,
			reportPosition,
			reveal,
			pendingReveal,
			consumeReveal,
			announce,
			toolSettled,
			decide,
			refresh,
			flush,
			attention,
			error,
			clearError,
		}),
		[
			state, panelOpen, setPanelOpen, width, setWidth, banner, dismissBanner, openDocument, openPath, upload, closeTab, setActive,
			reportPosition, reveal, pendingReveal, consumeReveal, announce, toolSettled, decide, refresh, flush, attention, error, clearError,
		],
	);
}
