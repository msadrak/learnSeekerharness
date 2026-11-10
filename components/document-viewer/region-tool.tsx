"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CropIcon, ListChecksIcon, MessageCircleQuestionIcon, QuoteIcon, XIcon, type LucideIcon } from "lucide-react";
import { MAX_EXCERPT_CHARS, type DocumentExcerpt, type PageRegion, type SessionDocument } from "@/src/core";
import { useT } from "@/components/i18n";
import { cn } from "@/lib/utils";
import { readRegion, RegionReadError, type RegionReading } from "./region-api";
import { boxOfRegion, clampBox, isUsableRegion, pointInPage, spanBetween, type Box, type Point } from "./region-geometry";
import { useReviewBeforeSend } from "./region-pref";
import { RegionSheet } from "./region-sheet";
import { sendBlockedReason, type RegionAction } from "./region-shared";
import { useDocumentViewer } from "./viewer-context";

/** Space between the region and the menu, and the room the menu needs above it (px). */
const GAP = 8;
const MENU_HEIGHT = 40;
const EDGE = 4;

/** `box` is relative to the viewer body; `region` is the page-fraction rectangle that goes to the server. */
type Phase =
	| { kind: "idle" }
	| { kind: "drawing"; box: Box }
	| { kind: "chosen"; page: number; region: PageRegion; box: Box }
	| { kind: "reading"; page: number; region: PageRegion; action: RegionAction }
	| { kind: "review"; page: number; region: PageRegion; action: RegionAction; reading: RegionReading }
	| { kind: "failed"; page: number; region: PageRegion; action: RegionAction; error: RegionReadError };

const IDLE: Phase = { kind: "idle" };

interface RegionToolProps {
	doc: SessionDocument;
	chatId: string;
	bodyRef: RefObject<HTMLElement | null>;
	/** The header toggle is on: drags draw a region. Alt+drag draws one either way. */
	active: boolean;
	onExit(): void;
}

/**
 * Screenshot regions for scanned PDFs: draw a rectangle on a page, pick Explain
 * this section / Quiz me / Quote, and the scan-reader model turns the crop into
 * text that goes to the agent as an ordinary excerpt (after the learner checked
 * it, unless they switched that off). Render with `key={doc.id}` so a tab switch
 * resets it.
 */
export function RegionTool({ doc, chatId, bodyRef, active, onExit }: RegionToolProps) {
	const t = useT();
	const r = t.chat.viewer.region;
	const s = t.chat.viewer.selection;
	const viewer = useDocumentViewer();
	const [phase, setPhase] = useState<Phase>(IDLE);
	const [review, setReview] = useReviewBeforeSend();
	const menuRef = useRef<HTMLDivElement>(null);
	const abortRef = useRef<AbortController | null>(null);
	const latest = useRef({ active, phase, review, viewer, onExit });
	useEffect(() => {
		latest.current = { active, phase, review, viewer, onExit };
	});

	const marking = active || phase.kind === "drawing";
	useEffect(() => {
		const body = bodyRef.current;
		if (!body || !marking) return;
		body.dataset.region = "on";
		return () => {
			delete body.dataset.region;
		};
	}, [bodyRef, marking]);

	useEffect(() => () => abortRef.current?.abort(), []);

	useEffect(() => {
		const body = bodyRef.current;
		if (!body) return;
		let drag: { pointerId: number; pageEl: HTMLElement; page: number; start: Point } | null = null;
		let suppressClick = false;

		const pageOf = (target: EventTarget | null): HTMLElement | null =>
			target instanceof Element ? target.closest<HTMLElement>(".page[data-page-number]") : null;
		const toBodyBox = (box: Box): Box => {
			const origin = body.getBoundingClientRect();
			return { ...box, left: box.left - origin.left, top: box.top - origin.top };
		};
		const regionAt = (event: PointerEvent): { rect: DOMRect; region: PageRegion } | null => {
			if (!drag) return null;
			const rect = drag.pageEl.getBoundingClientRect();
			return { rect, region: spanBetween(drag.start, pointInPage(rect, { x: event.clientX, y: event.clientY })) };
		};

		const onPointerDown = (event: PointerEvent) => {
			const { active: on, phase: current } = latest.current;
			if (event.button !== 0) return;
			const target = event.target instanceof Element ? event.target : null;
			if (current.kind === "chosen" && !target?.closest("[data-region-menu]") && !(on || event.altKey)) {
				setPhase(IDLE);
				return;
			}
			if (!(on || event.altKey)) return;
			if (current.kind === "reading" || current.kind === "review" || current.kind === "failed") return;
			const pageEl = pageOf(event.target);
			const page = Number(pageEl?.dataset.pageNumber);
			if (!pageEl || !Number.isInteger(page) || page < 1) return;
			event.preventDefault();
			try {
				body.setPointerCapture(event.pointerId);
			} catch {
				// no pointer capture (older engines, synthetic events): the drag still follows the body
			}
			const start = pointInPage(pageEl.getBoundingClientRect(), { x: event.clientX, y: event.clientY });
			drag = { pointerId: event.pointerId, pageEl, page, start };
			setPhase({ kind: "drawing", box: { left: 0, top: 0, width: 0, height: 0 } });
		};
		const onPointerMove = (event: PointerEvent) => {
			if (!drag || event.pointerId !== drag.pointerId) return;
			const at = regionAt(event);
			if (at) setPhase({ kind: "drawing", box: toBodyBox(boxOfRegion(at.rect, at.region)) });
		};
		const finish = (event: PointerEvent, cancelled: boolean) => {
			if (!drag || event.pointerId !== drag.pointerId) return;
			const at = regionAt(event);
			const { page } = drag;
			drag = null;
			try {
				body.releasePointerCapture(event.pointerId);
			} catch {
				// capture was never taken
			}
			// A link or control under the drag must not also fire its click.
			suppressClick = true;
			window.setTimeout(() => {
				suppressClick = false;
			}, 0);
			if (cancelled || !at || !isUsableRegion(at.rect, at.region)) {
				setPhase(IDLE);
				return;
			}
			setPhase({ kind: "chosen", page, region: at.region, box: toBodyBox(boxOfRegion(at.rect, at.region)) });
		};
		const onMouseDown = (event: MouseEvent) => {
			// Starting a drag must not also start a text selection.
			if (event.button === 0 && (latest.current.active || event.altKey) && pageOf(event.target)) event.preventDefault();
		};
		const onClick = (event: MouseEvent) => {
			if (suppressClick || (latest.current.active && pageOf(event.target))) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		const onScroll = () => {
			if (latest.current.phase.kind === "chosen") setPhase(IDLE);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			const { phase: current, active: on, onExit: exit } = latest.current;
			if (current.kind === "drawing") {
				drag = null;
				setPhase(IDLE);
			} else if (current.kind === "chosen" || current.kind === "failed") {
				setPhase(IDLE);
			} else if (current.kind === "reading") {
				abortRef.current?.abort();
				setPhase(IDLE);
			} else if (current.kind === "idle" && on) {
				exit();
			}
		};

		const onPointerUp = (event: PointerEvent) => finish(event, false);
		const onPointerCancel = (event: PointerEvent) => finish(event, true);

		body.addEventListener("pointerdown", onPointerDown, true);
		body.addEventListener("pointermove", onPointerMove);
		body.addEventListener("pointerup", onPointerUp);
		body.addEventListener("pointercancel", onPointerCancel);
		body.addEventListener("mousedown", onMouseDown, true);
		body.addEventListener("click", onClick, true);
		body.addEventListener("scroll", onScroll, { capture: true, passive: true });
		document.addEventListener("keydown", onKeyDown);
		return () => {
			body.removeEventListener("pointerdown", onPointerDown, true);
			body.removeEventListener("pointermove", onPointerMove);
			body.removeEventListener("pointerup", onPointerUp);
			body.removeEventListener("pointercancel", onPointerCancel);
			body.removeEventListener("mousedown", onMouseDown, true);
			body.removeEventListener("click", onClick, true);
			body.removeEventListener("scroll", onScroll, { capture: true });
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [bodyRef]);

	// Keep the menu inside the body area horizontally (it is centred on the region).
	const chosenBox = phase.kind === "chosen" ? phase.box : null;
	useLayoutEffect(() => {
		const menu = menuRef.current;
		const body = bodyRef.current;
		if (!menu || !body || !chosenBox) return;
		menu.style.marginLeft = "0px";
		const box = body.getBoundingClientRect();
		const rect = menu.getBoundingClientRect();
		const shift = Math.max(0, box.left + EDGE - rect.left) - Math.max(0, rect.right - (box.right - EDGE));
		menu.style.marginLeft = `${shift}px`;
	}, [chosenBox, bodyRef]);

	if (!viewer) return null;

	/** Hand the (checked) text to the chat as an excerpt: Explain / Quiz send at once, Quote attaches to the next message. */
	const dispatch = (action: RegionAction, page: number, region: PageRegion, snapshotId: string, text: string) => {
		const excerpt: DocumentExcerpt = { documentId: doc.id, name: doc.name, format: "pdf", quote: text, page, region, snapshotId };
		if (action === "quote") viewer.quoteExcerpt(excerpt);
		else void viewer.sendExcerpt(action, excerpt);
		setPhase(IDLE);
	};

	const run = (action: RegionAction, page: number, region: PageRegion) => {
		const controller = new AbortController();
		abortRef.current = controller;
		setPhase({ kind: "reading", page, region, action });
		readRegion(chatId, doc.id, page, region, controller.signal).then(
			(reading) => {
				if (controller.signal.aborted) return;
				const { review: checkFirst, viewer: current } = latest.current;
				const unavailable =
					reading.transcript.length > MAX_EXCERPT_CHARS ||
					(action !== "quote" && current !== null && sendBlockedReason(current.selectionGate, s) !== null);
				if (checkFirst || unavailable) setPhase({ kind: "review", page, region, action, reading });
				else dispatch(action, page, region, reading.snapshotId, reading.transcript);
			},
			(error: unknown) => {
				if (controller.signal.aborted) return;
				const failure = error instanceof RegionReadError ? error : new RegionReadError(error instanceof Error ? error.message : String(error));
				setPhase({ kind: "failed", page, region, action, error: failure });
			},
		);
	};

	const selectWholePage = () => {
		const body = bodyRef.current;
		if (!body) return;
		const page = viewer.state.positions[doc.id]?.page ?? 1;
		const pageEl = body.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`);
		if (!pageEl) return;
		const rect = pageEl.getBoundingClientRect();
		const origin = body.getBoundingClientRect();
		const box = clampBox(
			{ left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height },
			{ left: 0, top: 0, width: origin.width, height: origin.height },
		);
		setPhase({ kind: "chosen", page, region: { x: 0, y: 0, w: 1, h: 1 }, box });
	};

	const gateReason = sendBlockedReason(viewer.selectionGate, s);
	const items: { action: RegionAction; Icon: LucideIcon; reason: string | null }[] = [
		{ action: "explain", Icon: MessageCircleQuestionIcon, reason: gateReason },
		{ action: "quiz", Icon: ListChecksIcon, reason: gateReason },
		{ action: "quote", Icon: QuoteIcon, reason: null },
	];

	const menuBelow = phase.kind === "chosen" && phase.box.top < MENU_HEIGHT + GAP + EDGE;

	return (
		<>
			{active && phase.kind === "idle" && (
				<div
					role="group"
					aria-label={r.toggle}
					data-testid="region-hint"
					className="absolute inset-x-2 top-2 z-20 flex items-center gap-2 rounded-full border bg-popover py-1 ps-3 pe-1 font-ui text-xs shadow-float"
				>
					<CropIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate" title={r.hint}>
						{r.hint}
					</span>
					<button
						type="button"
						data-testid="region-whole-page"
						onClick={selectWholePage}
						className="shrink-0 rounded-full px-2.5 py-1 whitespace-nowrap hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
					>
						{r.wholePage}
					</button>
					<button
						type="button"
						aria-label={r.cancel}
						title={r.cancel}
						onClick={onExit}
						className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
					>
						<XIcon aria-hidden="true" className="size-3.5" />
					</button>
				</div>
			)}

			{(phase.kind === "drawing" || phase.kind === "chosen") && (
				<div
					aria-hidden="true"
					data-testid="region-box"
					style={{ left: phase.box.left, top: phase.box.top, width: phase.box.width, height: phase.box.height }}
					className="pointer-events-none absolute z-10 rounded-sm border-2 border-dashed border-brand bg-brand/10"
				/>
			)}

			{phase.kind === "chosen" && (
				<div
					ref={menuRef}
					role="toolbar"
					aria-label={r.menuLabel}
					data-testid="region-menu"
					data-region-menu=""
					onMouseDown={(event) => event.preventDefault()}
					style={{
						left: phase.box.left + phase.box.width / 2,
						top: menuBelow ? phase.box.top + phase.box.height + GAP : phase.box.top - GAP,
					}}
					className={cn(
						"absolute z-20 flex -translate-x-1/2 select-none items-center gap-0.5 rounded-full border bg-popover p-1 font-ui shadow-float",
						!menuBelow && "-translate-y-full",
					)}
				>
					{items.map(({ action, Icon, reason }) => (
						<button
							key={action}
							type="button"
							aria-disabled={reason !== null}
							title={reason ?? undefined}
							data-testid={`region-${action}`}
							onClick={() => {
								if (reason === null) run(action, phase.page, phase.region);
							}}
							className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs whitespace-nowrap text-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:opacity-60 aria-disabled:hover:bg-transparent"
						>
							<Icon aria-hidden="true" className="size-3.5" />
							{r[action]}
						</button>
					))}
				</div>
			)}

			{(phase.kind === "reading" || phase.kind === "review" || phase.kind === "failed") && (
				<RegionSheet
					state={
						phase.kind === "reading"
							? { kind: "reading" }
							: phase.kind === "review"
								? { kind: "review", transcript: phase.reading.transcript, snapshotId: phase.reading.snapshotId }
								: { kind: "failed", error: phase.error }
					}
					action={phase.action}
					page={phase.page}
					chatId={chatId}
					review={review}
					onReviewChange={setReview}
					onSubmit={(text) => {
						if (phase.kind === "review") dispatch(phase.action, phase.page, phase.region, phase.reading.snapshotId, text);
					}}
					onRetry={() => run(phase.action, phase.page, phase.region)}
					onClose={() => {
						abortRef.current?.abort();
						setPhase(IDLE);
					}}
				/>
			)}
		</>
	);
}
