"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ListChecksIcon, MessageCircleQuestionIcon, QuoteIcon, WaypointsIcon, type LucideIcon } from "lucide-react";
import {
	MAX_EXCERPT_CHARS,
	MAX_GRAPH_EXCERPT_CHARS,
	type DocumentExcerpt,
	type SessionDocument,
} from "@/src/core";
import { useT } from "@/components/i18n";
import { cn } from "@/lib/utils";
import { headingAbove, occurrenceOf } from "./dom-text";
import { addExcerptToGraph } from "./graph-import";
import { useDocumentViewer } from "./viewer-context";

/** Space between the selection and the menu, and the room the menu needs above the selection (px). */
const GAP = 8;
const MENU_HEIGHT = 40;
const EDGE = 4;

interface Snapshot {
	excerpt: DocumentExcerpt;
	/** Menu anchor relative to the body area. */
	x: number;
	y: number;
	below: boolean;
}

function startElement(range: Range): Element | null {
	const node = range.startContainer;
	return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** The excerpt for the current selection inside `body`, with the menu anchor; null when the selection is not a passage of this document. */
function readSelection(doc: SessionDocument, body: HTMLElement, menu: HTMLElement | null): Snapshot | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
	const range = selection.getRangeAt(0);
	const common = range.commonAncestorContainer;
	if (!body.contains(common) || menu?.contains(common)) return null;
	const quote = selection.toString().replace(/\s+/g, " ").trim();
	if (!quote) return null;

	const excerpt: DocumentExcerpt = { documentId: doc.id, name: doc.name, format: doc.format, quote };
	if (doc.format === "pdf") {
		const pageEl = startElement(range)?.closest<HTMLElement>(".page[data-page-number]");
		const page = Number(pageEl?.dataset.pageNumber);
		if (!pageEl || !Number.isInteger(page) || page < 1) return null;
		excerpt.page = page;
		const layer = pageEl.querySelector<HTMLElement>(".textLayer");
		excerpt.occurrence = layer ? occurrenceOf(layer, range, quote) : 0;
	} else {
		const root = body.querySelector<HTMLElement>("[data-doc-content]");
		if (!root || !root.contains(common)) return null;
		const section = headingAbove(root, range.startContainer);
		if (section) excerpt.section = section;
		excerpt.occurrence = occurrenceOf(root, range, quote);
	}

	const rect = range.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return null;
	const box = body.getBoundingClientRect();
	const below = rect.top - box.top < MENU_HEIGHT + GAP + EDGE;
	return {
		excerpt,
		x: rect.left + rect.width / 2 - box.left,
		y: (below ? rect.bottom : rect.top) - box.top + (below ? GAP : -GAP),
		below,
	};
}

/**
 * The floating menu over a selection in the active document: Explain / Quiz
 * me (sent at once), Quote (attached to the next message) and Add to graph.
 * The excerpt is captured when the menu opens, so the actions survive the
 * selection collapsing under the click. Render with `key={doc.id}` so a tab
 * switch hides it.
 */
export function SelectionMenu({ doc, bodyRef }: { doc: SessionDocument; bodyRef: RefObject<HTMLElement | null> }) {
	const t = useT();
	const s = t.chat.viewer.selection;
	const viewer = useDocumentViewer();
	const menuRef = useRef<HTMLDivElement>(null);
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

	useEffect(() => {
		const body = bodyRef.current;
		if (!body) return;
		let frame = 0;
		const hide = () => setSnapshot(null);
		const evaluate = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => setSnapshot(readSelection(doc, body, menuRef.current)));
		};
		const onSelectionChange = () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed) hide();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (event.key === "Shift" || event.key.startsWith("Arrow")) evaluate();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") hide();
		};
		document.addEventListener("selectionchange", onSelectionChange);
		document.addEventListener("pointerup", evaluate);
		document.addEventListener("keyup", onKeyUp);
		document.addEventListener("keydown", onKeyDown);
		body.addEventListener("scroll", hide, { capture: true, passive: true });
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("pointerup", evaluate);
			document.removeEventListener("keyup", onKeyUp);
			document.removeEventListener("keydown", onKeyDown);
			body.removeEventListener("scroll", hide, { capture: true });
		};
	}, [bodyRef, doc]);

	// Keep the menu inside the body area horizontally (it is centred on the selection).
	useLayoutEffect(() => {
		const menu = menuRef.current;
		const body = bodyRef.current;
		if (!menu || !body || !snapshot) return;
		menu.style.marginLeft = "0px";
		const box = body.getBoundingClientRect();
		const rect = menu.getBoundingClientRect();
		const shift = Math.max(0, box.left + EDGE - rect.left) - Math.max(0, rect.right - (box.right - EDGE));
		menu.style.marginLeft = `${shift}px`;
	}, [snapshot, bodyRef]);

	if (!viewer || !snapshot) return null;

	const { excerpt } = snapshot;
	const gate = viewer.selectionGate;
	const blocked = gate.busy ? s.busyHint : gate.pendingQuestion ? s.pendingHint : gate.activeProblem ? s.problemHint : null;
	const tooLong = excerpt.quote.length > MAX_EXCERPT_CHARS;
	const sendBlocked = tooLong ? s.tooLong : blocked;
	const graphBlocked = excerpt.quote.length > MAX_GRAPH_EXCERPT_CHARS ? s.tooLong : null;

	const done = () => {
		window.getSelection()?.removeAllRanges();
		setSnapshot(null);
	};

	const items: { key: string; label: string; Icon: LucideIcon; reason: string | null; run: () => void }[] = [
		{ key: "explain", label: s.explain, Icon: MessageCircleQuestionIcon, reason: sendBlocked, run: () => void viewer.sendExcerpt("explain", excerpt) },
		{ key: "quiz", label: s.quiz, Icon: ListChecksIcon, reason: sendBlocked, run: () => void viewer.sendExcerpt("quiz", excerpt) },
		{ key: "quote", label: s.quote, Icon: QuoteIcon, reason: tooLong ? s.tooLong : null, run: () => viewer.quoteExcerpt(excerpt) },
		{ key: "graph", label: s.addToGraph, Icon: WaypointsIcon, reason: graphBlocked, run: () => addExcerptToGraph(excerpt, t, viewer.openSetup) },
	];

	return (
		<div
			ref={menuRef}
			role="toolbar"
			aria-label={doc.name}
			data-testid="selection-menu"
			onMouseDown={(event) => event.preventDefault()}
			style={{ left: snapshot.x, top: snapshot.y }}
			className={cn(
				"absolute z-20 flex -translate-x-1/2 select-none items-center gap-0.5 rounded-full border bg-popover p-1 font-ui shadow-float",
				!snapshot.below && "-translate-y-full",
			)}
		>
			{items.map(({ key, label, Icon, reason, run }) => (
				<button
					key={key}
					type="button"
					aria-disabled={reason !== null}
					title={reason ?? undefined}
					data-testid={`selection-${key}`}
					onClick={() => {
						if (reason !== null) return;
						run();
						done();
					}}
					className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs whitespace-nowrap text-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:opacity-60 aria-disabled:hover:bg-transparent"
				>
					<Icon aria-hidden="true" className="size-3.5" />
					{label}
				</button>
			))}
		</div>
	);
}
