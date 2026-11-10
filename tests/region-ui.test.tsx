/**
 * The learner's side of screenshot regions: the transcript check (edit, gate,
 * length), the failure states, and correcting a sent region from its chat card.
 * Rendered with the viewer context stubbed; pointer drawing and geometry need a
 * real layout engine and are covered by the geometry tests and the browser pass.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DocumentExcerptCard } from "../components/document-excerpt-card.tsx";
import { RegionReadError } from "../components/document-viewer/region-api.ts";
import { RegionSheet } from "../components/document-viewer/region-sheet.tsx";
import { DocumentViewerContext, type DocumentViewerApi, type SelectionGate } from "../components/document-viewer/viewer-context.tsx";
import { MAX_EXCERPT_CHARS, MODELS_NOT_CONFIGURED_CODE, REGION_EMPTY_CODE, type DocumentExcerpt } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
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

const OPEN: SelectionGate = { busy: false, pendingQuestion: false, activeProblem: false };

interface Sent {
	action: "explain" | "quiz";
	excerpt: DocumentExcerpt;
}

/** Only the members these components read; the rest of the viewer API is irrelevant here. */
function viewerStub(gate: SelectionGate = OPEN) {
	const sent: Sent[] = [];
	const calls = { setup: 0 };
	const stub = {
		selectionGate: gate,
		sendExcerpt: async (action: "explain" | "quiz", excerpt: DocumentExcerpt) => {
			sent.push({ action, excerpt });
		},
		openSetup: () => {
			calls.setup++;
		},
		reveal: () => {},
	} as unknown as DocumentViewerApi; // the stub carries just the members under test
	return { stub, sent, calls };
}

async function render(node: React.ReactNode, api: DocumentViewerApi): Promise<void> {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<DocumentViewerContext.Provider value={api}>{node}</DocumentViewerContext.Provider>));
}

function byTestId<T extends Element>(id: string): T {
	const el = document.querySelector<T>(`[data-testid="${id}"]`);
	assert.ok(el, `${id} is rendered`);
	return el;
}

interface ChangeProps {
	onChange?: (event: { target: { value: string } }) => void;
}

/** linkedom does not turn DOM input events into React changes, so call the field's own onChange handler. */
async function typeInto(el: HTMLTextAreaElement, value: string): Promise<void> {
	const propsKey = Object.keys(el).find((key) => key.startsWith("__reactProps$"));
	assert.ok(propsKey, "the field is a React element");
	const props = (el as unknown as Record<string, ChangeProps | undefined>)[propsKey]; // React's internal props bag on the node
	const onChange = props?.onChange;
	assert.ok(onChange, "the field is controlled");
	await act(async () => onChange({ target: { value } }));
}

const noop = () => {};

describe("the transcript check", () => {
	const review = { kind: "review" as const, transcript: "  Energy is conserved.  ", snapshotId: "a".repeat(64) };
	const base = { page: 3, chatId: "chat_test", review: true, onReviewChange: noop, onRetry: noop, onClose: noop };

	it("sends the learner's edited text, trimmed, with the direction taken from the text", async () => {
		const { stub } = viewerStub();
		const submitted: string[] = [];
		await render(<RegionSheet {...base} state={review} action="explain" onSubmit={(text) => submitted.push(text)} />, stub);
		const field = byTestId<HTMLTextAreaElement>("region-text");
		assert.equal(field.getAttribute("dir"), "ltr");
		await act(async () => byTestId<HTMLButtonElement>("region-submit").click());
		assert.deepEqual(submitted, ["Energy is conserved."], "the field starts as the transcript");
		await typeInto(field, "  انرژی پایسته است. E=mc^2  ");
		assert.equal(byTestId("region-text").getAttribute("dir"), "rtl");
		await act(async () => byTestId<HTMLButtonElement>("region-submit").click());
		assert.deepEqual(submitted, ["Energy is conserved.", "انرژی پایسته است. E=mc^2"]);
	});

	it("holds Explain / Quiz while the agent is busy, but never holds Quote", async () => {
		const busy = viewerStub({ ...OPEN, busy: true });
		const submitted: string[] = [];
		await render(<RegionSheet {...base} state={review} action="explain" onSubmit={(text) => submitted.push(text)} />, busy.stub);
		const explain = byTestId<HTMLButtonElement>("region-submit");
		assert.equal(explain.getAttribute("aria-disabled"), "true");
		assert.equal(explain.getAttribute("title"), "Available when the agent finishes");
		await act(async () => explain.click());
		assert.equal(submitted.length, 0);

		await act(async () => root!.render(
			<DocumentViewerContext.Provider value={busy.stub}>
				<RegionSheet {...base} state={review} action="quote" onSubmit={(text) => submitted.push(text)} />
			</DocumentViewerContext.Provider>,
		));
		const quote = byTestId<HTMLButtonElement>("region-submit");
		assert.equal(quote.getAttribute("aria-disabled"), "false");
		await act(async () => quote.click());
		assert.deepEqual(submitted, ["Energy is conserved."]);
	});

	it("refuses text over the excerpt limit and an empty transcript, and says why", async () => {
		const { stub } = viewerStub();
		const submitted: string[] = [];
		const sheet = (transcript: string, snapshotId: string) => (
			<DocumentViewerContext.Provider value={stub}>
				<RegionSheet {...base} state={{ kind: "review", transcript, snapshotId }} action="quiz" onSubmit={(text) => submitted.push(text)} />
			</DocumentViewerContext.Provider>
		);
		await render(sheet("x".repeat(MAX_EXCERPT_CHARS + 1), "c".repeat(64)), stub);
		assert.equal(byTestId("region-submit").getAttribute("aria-disabled"), "true");
		assert.match(document.body.textContent ?? "", /too long \(max 4,000 characters\)/);
		await act(async () => byTestId<HTMLButtonElement>("region-submit").click());
		await act(async () => root!.render(sheet("   ", "d".repeat(64))));
		assert.equal(byTestId("region-submit").getAttribute("aria-disabled"), "true");
		await act(async () => byTestId<HTMLButtonElement>("region-submit").click());
		assert.equal(submitted.length, 0);
		await act(async () => root!.render(sheet("x".repeat(MAX_EXCERPT_CHARS), "e".repeat(64))));
		assert.equal(byTestId("region-submit").getAttribute("aria-disabled"), "false", "exactly the limit still goes");
	});
});

describe("a failed read", () => {
	const props = { page: 1, chatId: "chat_test", action: "explain" as const, review: true, onReviewChange: noop, onSubmit: noop };

	it("offers Try again for an unreadable region", async () => {
		const { stub } = viewerStub();
		let retries = 0;
		await render(<RegionSheet {...props} state={{ kind: "failed", error: new RegionReadError("No readable text in this region.", REGION_EMPTY_CODE) }} onRetry={() => retries++} onClose={noop} />, stub);
		assert.match(document.body.textContent ?? "", /No readable text was found in this selection\./);
		await act(async () => byTestId<HTMLButtonElement>("region-retry").click());
		assert.equal(retries, 1);
	});

	it("sends an unconfigured model to setup instead of offering a retry that cannot work", async () => {
		const { stub, calls } = viewerStub();
		let closed = 0;
		await render(<RegionSheet {...props} state={{ kind: "failed", error: new RegionReadError("No model configured — set up your models first", MODELS_NOT_CONFIGURED_CODE) }} onRetry={noop} onClose={() => closed++} />, stub);
		assert.equal(document.querySelector('[data-testid="region-retry"]'), null);
		const setup = [...document.querySelectorAll("button")].find((b) => b.textContent === "Set up models");
		assert.ok(setup);
		await act(async () => setup.click());
		assert.equal(calls.setup, 1);
		assert.equal(closed, 1);
	});
});

describe("a region on its chat card", () => {
	const region: DocumentExcerpt = {
		documentId: "doc_0123456789ab",
		name: "scan.pdf",
		format: "pdf",
		quote: "Energy is concerved.",
		page: 4,
		region: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
		snapshotId: "b".repeat(64),
	};

	it("corrects the transcript and sends it again as a correction", async () => {
		const { stub, sent } = viewerStub();
		await render(<DocumentExcerptCard data={{ action: "explain", excerpts: [region] }} />, stub);
		assert.match(byTestId("document-excerpt-card").textContent ?? "", /Explain this section/);
		await act(async () => byTestId<HTMLButtonElement>("excerpt-edit").click());
		await typeInto(byTestId<HTMLTextAreaElement>("excerpt-edit-text"), "  Energy is conserved.  ");
		await act(async () => byTestId<HTMLButtonElement>("excerpt-resend").click());
		assert.deepEqual(sent, [{ action: "explain", excerpt: { ...region, quote: "Energy is conserved.", corrected: true } }]);
		assert.equal(document.querySelector('[data-testid="excerpt-edit-text"]'), null, "the editor closes after sending");
	});

	it("keeps the correction out of reach while the agent is busy", async () => {
		const { stub, sent } = viewerStub({ ...OPEN, busy: true });
		await render(<DocumentExcerptCard data={{ action: "quiz", excerpts: [region] }} />, stub);
		await act(async () => byTestId<HTMLButtonElement>("excerpt-edit").click());
		const resend = byTestId<HTMLButtonElement>("excerpt-resend");
		assert.equal(resend.getAttribute("aria-disabled"), "true");
		await act(async () => resend.click());
		assert.deepEqual(sent, []);
	});

	it("offers no correction for a plain text passage or a quoted region", async () => {
		const { stub } = viewerStub();
		const { region: _region, snapshotId: _snapshot, ...text } = region;
		await render(<DocumentExcerptCard data={{ action: "explain", excerpts: [text] }} />, stub);
		assert.equal(document.querySelector('[data-testid="excerpt-edit"]'), null);
		await act(async () => root!.render(
			<DocumentViewerContext.Provider value={stub}>
				<DocumentExcerptCard data={{ action: "quote", excerpts: [region], text: "why?" }} />
			</DocumentViewerContext.Provider>,
		));
		assert.equal(document.querySelector('[data-testid="excerpt-edit"]'), null);
	});
});
