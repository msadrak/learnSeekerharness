"use client";

import { useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useT } from "@/components/i18n";
import { cn } from "@/lib/utils";

/** Panel minimum (px) and transcript-column minimum (px) from the plan. */
export const VIEWER_PANEL_MIN_PX = 320;
export const VIEWER_COLUMN_MIN_PX = 420;
/** Below this session-area width the open panel overlays the transcript full-width. */
export const VIEWER_OVERLAY_BELOW_PX = VIEWER_PANEL_MIN_PX + VIEWER_COLUMN_MIN_PX;

const KEY_STEP = 0.02;

/** Clamp a panel fraction so the panel keeps 320px and the transcript column 420px (the panel minimum wins when both cannot hold). */
export function clampPanelFraction(fraction: number, containerWidth: number): number {
	if (!(containerWidth > 0)) return fraction;
	const min = VIEWER_PANEL_MIN_PX / containerWidth;
	const max = Math.max(min, 1 - VIEWER_COLUMN_MIN_PX / containerWidth);
	return Math.min(max, Math.max(min, fraction));
}

/**
 * The drag handle between the transcript column and the viewer panel. The
 * panel sits at the inline-end of `containerRef` (the session area), so the
 * fraction is measured from that edge: right in LTR, left in RTL.
 */
export function ViewerSplitter({
	containerRef,
	width,
	onWidthChange,
}: {
	containerRef: RefObject<HTMLElement | null>;
	/** Current panel fraction of the session area. */
	width: number;
	onWidthChange: (fraction: number) => void;
}) {
	const t = useT();
	const [dragging, setDragging] = useState(false);

	const geometry = () => {
		const container = containerRef.current;
		if (!container) return null;
		const rect = container.getBoundingClientRect();
		return { rect, rtl: getComputedStyle(container).direction === "rtl" };
	};

	const move = (clientX: number) => {
		const g = geometry();
		if (!g || g.rect.width <= 0) return;
		const fraction = g.rtl ? (clientX - g.rect.left) / g.rect.width : (g.rect.right - clientX) / g.rect.width;
		onWidthChange(clampPanelFraction(fraction, g.rect.width));
	};

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault(); // no text selection while dragging
		event.currentTarget.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		setDragging(true);
	};

	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		setDragging(false);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		const g = geometry();
		if (!g) return;
		event.preventDefault();
		// Moving the separator towards the transcript widens the panel.
		const towardsStart = event.key === "ArrowLeft" ? !g.rtl : g.rtl;
		const widerDirection = towardsStart ? 1 : -1;
		onWidthChange(clampPanelFraction(width + widerDirection * KEY_STEP, g.rect.width));
	};

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={t.chat.viewer.resize}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(width * 100)}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={(event) => {
				if (dragging) move(event.clientX);
			}}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onKeyDown={onKeyDown}
			data-testid="viewer-splitter"
			className={cn(
				"group relative z-10 w-1.5 shrink-0 cursor-col-resize touch-none outline-none",
				"focus-visible:ring-2 focus-visible:ring-ring/60",
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors duration-150 motion-reduce:transition-none group-hover:w-0.5 group-hover:bg-brand/60",
					dragging && "w-0.5 bg-brand",
				)}
			/>
		</div>
	);
}
