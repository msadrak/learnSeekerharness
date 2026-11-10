import type { Ref } from "react";
import type { DocumentAnnotation, DocumentLocation, SessionDocument } from "@/src/core";
import type { Messages } from "@/components/i18n";
import type { RevealTarget } from "./viewer-context";

/** How far a reveal got: the passage was found and flashed, only its page could be shown, or nothing. */
export type RevealResult = "passage" | "page" | "none";

/** What the panel can ask the active document view to do (React 19 `ref` prop on each view). */
export interface ViewerViewHandle {
	/** Scroll to the passage (centred) and flash it; PDF falls back to the page. */
	reveal(target: RevealTarget): Promise<RevealResult>;
}

export interface ViewerViewProps {
	ref?: Ref<ViewerViewHandle>;
	doc: SessionDocument;
	chatId: string;
	/** The saved reading position (restored once the content is ready). */
	initialLocation: DocumentLocation | undefined;
	/** This document's annotations (pending ones are underlined; accepted ones drawn where the format cannot show the file's own). */
	annotations: readonly DocumentAnnotation[];
	/** Changes when an accepted annotation changed the file on disk (PDF and Markdown reload). */
	contentVersion: string;
	/** The learner scrolled to a new page / section. */
	onLocation(loc: DocumentLocation): void;
	/** The content is rendered and revealable (true) / gone (false, also on unmount). */
	onReady(ready: boolean): void;
}

export function documentUrl(chatId: string, doc: SessionDocument, kind: "file" | "html"): string {
	return `/api/chats/${chatId}/documents/${doc.id}/${kind}`;
}

/** The localized reason a document fetch failed (404 missing file, 403 guard message, anything else unreadable). */
export async function loadErrorMessage(res: Response, v: Messages["chat"]["viewer"], doc: SessionDocument): Promise<string> {
	const body = (await res.json().catch(() => null)) as { error?: string; path?: string } | null;
	if (res.status === 404) return v.missing(body?.path ?? (doc.source.kind === "path" ? doc.source.path : doc.name));
	if (res.status === 403 && body?.error) return body.error;
	return v.unreadable;
}

/** A fetch failure with a ready-to-show message. */
export class ViewLoadError extends Error {}
