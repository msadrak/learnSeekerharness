"use client";

import { useEffect, useImperativeHandle, useRef, type RefObject } from "react";
import {
	clearHighlights,
	headingAtScrollTop,
	rangesForQuote,
	scrollRangeToCenter,
	setHighlight,
} from "./dom-text";
import type { ViewerViewHandle, ViewerViewProps } from "./view-handle";

const POSITION_THROTTLE_MS = 500;

interface TextDocumentOptions
	extends Pick<ViewerViewProps, "ref" | "initialLocation" | "annotations" | "onLocation" | "onReady"> {
	/** The rendered content is in the DOM. */
	ready: boolean;
	/** Changes when the rendered content was replaced wholesale (a different document). */
	contentKey: string;
	/** Changes whenever the rendered text changed in place (re-applies highlights). */
	revision?: string;
	/** The scroll container. */
	containerRef: RefObject<HTMLElement | null>;
	/** The element holding the rendered document. */
	contentRef: RefObject<HTMLElement | null>;
}

/**
 * Behavior shared by the Word and Markdown views, which render document text
 * into the DOM: saved-section restore, section reporting on scroll,
 * annotation highlights, and the reveal handle.
 */
export function useTextDocument(options: TextDocumentOptions): void {
	const { ready, contentKey, containerRef, contentRef } = options;
	const latest = useRef(options);
	useEffect(() => {
		latest.current = options;
	});

	useImperativeHandle(
		options.ref,
		(): ViewerViewHandle => ({
			async reveal(target) {
				const container = containerRef.current;
				const content = contentRef.current;
				if (!container || !content || !target.quote) return "none";
				const ranges = rangesForQuote(content, target.quote);
				const range = ranges[target.occurrence ?? 0] ?? ranges[0];
				if (!range) return "none";
				scrollRangeToCenter(container, range);
				setHighlight("lh-doc-flash", [range]);
				return "passage";
			},
		}),
		[containerRef, contentRef],
	);

	// Ready: restore the saved section, report the section on scroll.
	useEffect(() => {
		const container = containerRef.current;
		const content = contentRef.current;
		if (!ready || !container || !content) return;

		const saved = latest.current.initialLocation?.section;
		if (saved) {
			const heading = Array.from(content.querySelectorAll("h1,h2,h3,h4,h5,h6")).find(
				(h) => h.textContent?.replace(/\s+/g, " ").trim().slice(0, 200) === saved,
			);
			if (heading) {
				container.scrollTo({ top: container.scrollTop + heading.getBoundingClientRect().top - container.getBoundingClientRect().top });
			}
		}
		latest.current.onReady(true);

		let timer: number | null = null;
		const report = () => {
			const section = headingAtScrollTop(content, container);
			latest.current.onLocation(section ? { section } : {});
		};
		const onScroll = () => {
			if (timer !== null) return;
			timer = window.setTimeout(() => {
				timer = null;
				report();
			}, POSITION_THROTTLE_MS);
		};
		container.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			container.removeEventListener("scroll", onScroll);
			clearTimeout(timer ?? undefined);
			latest.current.onReady(false);
			clearHighlights();
		};
	}, [ready, contentKey, containerRef, contentRef]);

	// Pending proposals are underlined; accepted ones drawn (mammoth / the rendered Markdown cannot show the file's own marks).
	useEffect(() => {
		const content = contentRef.current;
		if (!ready || !content) return;
		const pending: Range[] = [];
		const written: Range[] = [];
		for (const annotation of options.annotations) {
			if (annotation.status === "pending") pending.push(...rangesForQuote(content, annotation.quote));
			else if (annotation.status === "accepted") written.push(...rangesForQuote(content, annotation.quote));
		}
		setHighlight("lh-doc-pending", pending);
		setHighlight("lh-doc-annotation", written);
	}, [ready, contentKey, options.revision, options.annotations, contentRef]);
}
