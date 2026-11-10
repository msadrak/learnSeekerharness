import type { PageRegion } from "@/src/core";

/** Smallest rectangle a drag may select, in px on each side of the page as displayed. */
export const MIN_REGION_PX = 24;

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}

/** A client-space point as fractions of the page box, clamped to the page. */
export function pointInPage(page: Box, point: Point): Point {
	if (page.width <= 0 || page.height <= 0) return { x: 0, y: 0 };
	return {
		x: Math.min(1, Math.max(0, (point.x - page.left) / page.width)),
		y: Math.min(1, Math.max(0, (point.y - page.top) / page.height)),
	};
}

/** The rectangle spanned by two fractional points (either corner order); may be empty. */
export function spanBetween(a: Point, b: Point): PageRegion {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return { x, y, w: Math.max(a.x, b.x) - x, h: Math.max(a.y, b.y) - y };
}

/** The client-space box of a region on a page box. */
export function boxOfRegion(page: Box, region: PageRegion): Box {
	return {
		left: page.left + region.x * page.width,
		top: page.top + region.y * page.height,
		width: region.w * page.width,
		height: region.h * page.height,
	};
}

/** True when both sides are at least MIN_REGION_PX on the page as displayed. */
export function isUsableRegion(page: Box, region: PageRegion): boolean {
	return region.w * page.width >= MIN_REGION_PX && region.h * page.height >= MIN_REGION_PX;
}

/** The part of `box` inside `bounds` (zero-size at the bounds' corner when they do not overlap). */
export function clampBox(box: Box, bounds: Box): Box {
	const left = Math.max(box.left, bounds.left);
	const top = Math.max(box.top, bounds.top);
	const right = Math.max(left, Math.min(box.left + box.width, bounds.left + bounds.width));
	const bottom = Math.max(top, Math.min(box.top + box.height, bounds.top + bounds.height));
	return { left, top, width: right - left, height: bottom - top };
}

/** The smallest rectangle holding every region (one flash target for a passage that spans several lines). */
export function boundingRegion(regions: readonly PageRegion[]): PageRegion {
	const x = Math.min(...regions.map((r) => r.x));
	const y = Math.min(...regions.map((r) => r.y));
	return {
		x,
		y,
		w: Math.max(...regions.map((r) => r.x + r.w)) - x,
		h: Math.max(...regions.map((r) => r.y + r.h)) - y,
	};
}
