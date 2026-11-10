"use client";

import { createContext, useContext } from "react";
import type { ChatViewerState, DocumentExcerpt, DocumentLocation, PageRegion } from "@/src/core";

/** Where a reveal points: a document and (optionally) a passage / page(s). */
export interface RevealTarget {
	documentId: string;
	quote?: string;
	page?: number;
	endPage?: number;
	/** Index among identical matches within the page (PDF) or document. */
	occurrence?: number;
	/** A screenshot region on `page` (PDF): flashed as a rectangle instead of a passage. */
	region?: PageRegion;
}

/** The viewer-header banner: the agent pointed to / opened something. */
export interface ViewerBanner {
	toolCallId: string;
	target: RevealTarget;
	kind: "point" | "open";
}

/** A reveal waiting for its document view to be ready (consumed by the panel). */
export interface PendingReveal {
	seq: number;
	target: RevealTarget;
}

/** Why selection actions that send a message are unavailable right now. */
export interface SelectionGate {
	/** A turn is running. */
	busy: boolean;
	/** A question or reading is waiting in the dock. */
	pendingQuestion: boolean;
	/** A practice problem is active. */
	activeProblem: boolean;
}

/** The viewer's own state and actions (implemented by useViewerState). */
export interface ViewerStateApi {
	state: ChatViewerState;
	panelOpen: boolean;
	setPanelOpen(open: boolean): void;
	/** Panel width as a fraction of the session area (device preference). */
	width: number;
	setWidth(fraction: number): void;
	banner: ViewerBanner | null;
	dismissBanner(): void;
	/** Show a document: tab added, made active, panel opened. */
	openDocument(id: string): void;
	openPath(path: string): Promise<void>;
	upload(file: File): Promise<void>;
	closeTab(id: string): void;
	setActive(id: string): void;
	reportPosition(id: string, loc: DocumentLocation): void;
	/** Open the panel, activate the document and ask its view to scroll to / flash the target. */
	reveal(target: RevealTarget): void;
	pendingReveal: PendingReveal | null;
	consumeReveal(seq: number): void;
	/** A point_to_passage / open_document card appeared live: set the banner (and the dot when hidden). */
	announce(toolCallId: string, target: RevealTarget, kind: "point" | "open"): void;
	/** A document tool card appeared live: refresh the viewer state from the server. */
	toolSettled(toolCallId: string): void;
	decide(ids: string[], decision: "accept" | "reject"): Promise<void>;
	/** Refetch GET /viewer (record-changed, tool cards). */
	refresh(): Promise<void>;
	/** Send any pending layout PUT now. */
	flush(): Promise<void>;
	/** The top-bar dot: something was announced while the panel was hidden. */
	attention: boolean;
	/** Last open/upload error, already localized; null when none. */
	error: string | null;
	clearError(): void;
}

/** Everything the viewer UI and the transcript cards consume (Chat provides it). */
export interface DocumentViewerApi extends ViewerStateApi {
	/** Passages attached to the next message (Quote in message). */
	quotes: DocumentExcerpt[];
	removeQuote(index: number): void;
	selectionGate: SelectionGate;
	/** Explain / Quiz me: send immediately (Chat flushes the layout first). */
	sendExcerpt(action: "explain" | "quiz", excerpt: DocumentExcerpt): Promise<void>;
	/** Quote: attach a chip, or insert into the dock's field when a question / reading / problem owns the dock. */
	quoteExcerpt(excerpt: DocumentExcerpt): void;
	/** Opens the model setup dialog (graph import refused: models/keys not configured). */
	openSetup(): void;
}

/** Null outside `Chat` (the editor chips and other surfaces stay presentation-only). */
export const DocumentViewerContext = createContext<DocumentViewerApi | null>(null);

export function useDocumentViewer(): DocumentViewerApi | null {
	return useContext(DocumentViewerContext);
}
