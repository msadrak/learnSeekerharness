"use client";

import { useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { mdComponents } from "@/components/md-blocks";
import { useT } from "@/components/i18n";
import { documentUrl, loadErrorMessage, ViewLoadError, type ViewerViewProps } from "./view-handle";
import { useTextDocument } from "./text-document";

interface MarkdownContent {
	key: string;
	text?: string;
	error?: string;
}

// Relative images cannot resolve against a file on disk: alt text only.
const viewerComponents = {
	...mdComponents,
	img: ({ alt }: { alt?: string }) => <span className="text-muted-foreground">{alt}</span>,
};

/** Markdown: the file's source rendered with the app's Markdown renderer. */
export function MarkdownView({ ref, doc, chatId, initialLocation, annotations, contentVersion, onLocation, onReady }: ViewerViewProps) {
	const t = useT();
	const v = t.chat.viewer;
	const containerRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [content, setContent] = useState<MarkdownContent>({ key: "" });
	const key = `${chatId}:${doc.id}`;
	const vRef = useRef(v);
	useEffect(() => {
		vRef.current = v;
	});

	useEffect(() => {
		const abort = new AbortController();
		void (async () => {
			try {
				const res = await fetch(documentUrl(chatId, doc, "file"), { signal: abort.signal, cache: "no-store" });
				if (!res.ok) throw new ViewLoadError(await loadErrorMessage(res, vRef.current, doc));
				setContent({ key, text: await res.text() });
			} catch (err) {
				if (abort.signal.aborted) return;
				setContent({ key, error: err instanceof ViewLoadError ? err.message : vRef.current.unreadable });
			}
		})();
		return () => abort.abort();
	}, [key, contentVersion]);

	const text = content.key === key ? content.text : undefined;
	const error = content.key === key ? content.error : undefined;

	useTextDocument({
		ref,
		ready: text !== undefined,
		contentKey: key,
		revision: text,
		containerRef,
		contentRef,
		initialLocation,
		annotations,
		onLocation,
		onReady,
	});

	return (
		<div ref={containerRef} className="absolute inset-0 overflow-auto">
			{text !== undefined ? (
				<div ref={contentRef} data-doc-content className="px-6 py-5">
					<MessageResponse mode="static" components={viewerComponents}>
						{text}
					</MessageResponse>
				</div>
			) : (
				<p role={error ? "alert" : "status"} className="p-6 text-center text-sm text-muted-foreground">
					{error ?? v.loading}
				</p>
			)}
		</div>
	);
}
