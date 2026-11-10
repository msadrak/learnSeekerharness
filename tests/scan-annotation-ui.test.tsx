/**
 * The annotation strip's jump for a proposal on a scanned page: it has no text to find, so the
 * strip hands the viewer the page and the box around the placed lines. Rendered with the viewer
 * context stubbed; the box drawing itself needs a real layout engine and is covered by the browser pass.
 */
import React, { act } from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AnnotationStrip } from "../components/document-viewer/annotation-strip.tsx";
import { DocumentViewerContext, type DocumentViewerApi, type RevealTarget } from "../components/document-viewer/viewer-context.tsx";
import type { DocumentAnnotation } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
});

const annotation = (over: Partial<DocumentAnnotation>): DocumentAnnotation => ({
	id: "ann_00000001",
	documentId: "doc_000000000001",
	quote: "I am, I exist",
	note: "the cogito",
	toolCallId: "call_1",
	proposedAt: "2026-01-01T00:00:00.000Z",
	status: "pending",
	reported: false,
	...over,
});

async function click(annotations: DocumentAnnotation[], snippet: string): Promise<RevealTarget[]> {
	const revealed: RevealTarget[] = [];
	const api = {
		state: { annotations },
		reveal: (target: RevealTarget) => revealed.push(target),
		decide: async () => {},
	} as unknown as DocumentViewerApi; // the stub carries just the members the strip reads
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<DocumentViewerContext.Provider value={api}><AnnotationStrip documentId="doc_000000000001" /></DocumentViewerContext.Provider>));
	const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(snippet));
	assert.ok(button, "the proposal's quote button is rendered");
	await act(async () => button.click());
	return revealed;
}

describe("AnnotationStrip jump", () => {
	it("takes a scanned-page proposal to its page and the box around every placed line", async () => {
		const regions = [{ x: 0.1, y: 0.2, w: 0.5, h: 0.05 }, { x: 0.15, y: 0.26, w: 0.3, h: 0.05 }];
		const [target] = await click([annotation({ page: 38, regions })], "I am, I exist");
		assert.deepEqual([target?.documentId, target?.quote, target?.page], ["doc_000000000001", "I am, I exist", 38]);
		const region = target?.region;
		assert.ok(region, "the jump carries a box");
		assert.deepEqual([region.x, region.y, region.w], [0.1, 0.2, 0.5], "the box starts at the leftmost line and spans the widest");
		assert.ok(Math.abs(region.h - 0.11) < 1e-9, "and reaches the bottom of the last line");
	});

	it("still finds a text-layer proposal by its quote alone", async () => {
		const revealed = await click([annotation({ page: 2 })], "I am, I exist");
		assert.deepEqual(revealed, [{ documentId: "doc_000000000001", quote: "I am, I exist", page: 2 }]);
	});
});
