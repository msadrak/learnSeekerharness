"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/components/i18n";
import { textDirection } from "@/lib/i18n/direction";
import { documentUrl, loadErrorMessage, ViewLoadError, type ViewerViewProps } from "./view-handle";
import { useTextDocument } from "./text-document";

const DIRECTED_BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, td, th";

interface DocxContent {
	key: string;
	html?: string;
	error?: string;
}

/** Word (.docx): the server's sanitized mammoth HTML in the teaching-prose style. */
export function DocxView({ ref, doc, chatId, initialLocation, annotations, onLocation, onReady }: ViewerViewProps) {
	const t = useT();
	const v = t.chat.viewer;
	const containerRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [content, setContent] = useState<DocxContent>({ key: "" });
	const key = `${chatId}:${doc.id}`;
	const vRef = useRef(v);
	useEffect(() => {
		vRef.current = v;
	});

	useEffect(() => {
		const abort = new AbortController();
		void (async () => {
			try {
				const res = await fetch(documentUrl(chatId, doc, "html"), { signal: abort.signal, cache: "no-store" });
				if (!res.ok) throw new ViewLoadError(await loadErrorMessage(res, vRef.current, doc));
				const body = (await res.json()) as { html?: unknown };
				if (typeof body.html !== "string") throw new ViewLoadError(vRef.current.unreadable);
				setContent({ key, html: body.html });
			} catch (err) {
				if (abort.signal.aborted) return;
				setContent({ key, error: err instanceof ViewLoadError ? err.message : vRef.current.unreadable });
			}
		})();
		return () => abort.abort();
	}, [key]);

	const html = content.key === key ? content.html : undefined;

	// Per-block direction (any Arabic letter => RTL), links that never navigate the app away.
	useLayoutEffect(() => {
		const root = contentRef.current;
		if (!root || html === undefined) return;
		for (const block of root.querySelectorAll<HTMLElement>(DIRECTED_BLOCKS)) block.dir = textDirection(block.textContent ?? "");
		for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
			if (!link.getAttribute("href")?.startsWith("#")) {
				link.target = "_blank";
				link.rel = "noopener noreferrer";
			}
		}
	}, [html]);

	useTextDocument({
		ref,
		ready: html !== undefined,
		contentKey: key,
		containerRef,
		contentRef,
		initialLocation,
		annotations,
		onLocation,
		onReady,
	});

	const error = content.key === key ? content.error : undefined;

	return (
		<div
			ref={containerRef}
			className="absolute inset-0 overflow-auto"
			onClick={(event) => {
				// In-document anchors (footnotes, tables of contents) scroll inside the panel; they never touch the URL hash.
				const anchor = (event.target as Element).closest?.("a[href^='#']");
				if (!anchor) return;
				event.preventDefault();
				const id = decodeURIComponent(anchor.getAttribute("href")!.slice(1));
				const target = Array.from(contentRef.current?.querySelectorAll("[id]") ?? []).find((el) => el.id === id);
				target?.scrollIntoView({ block: "start" });
			}}
		>
			{html !== undefined ? (
				<div ref={contentRef} data-doc-content className="lh-prose px-6 py-5" dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<p role={error ? "alert" : "status"} className="p-6 text-center text-sm text-muted-foreground">
					{error ?? v.loading}
				</p>
			)}
		</div>
	);
}
