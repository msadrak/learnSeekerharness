"use client";

import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type * as PdfJs from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type * as PdfViewerLib from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { locateAll, type PageRegion } from "@/src/core";
import { useT } from "@/components/i18n";
import { clearHighlights, rangesForQuote, scrollRangeToCenter, setHighlight } from "./dom-text";
import type { RevealTarget } from "./viewer-context";
import { documentUrl, loadErrorMessage, ViewLoadError, type RevealResult, type ViewerViewProps } from "./view-handle";

interface PdfLibs {
	pdfjs: typeof PdfJs;
	viewerLib: typeof PdfViewerLib;
}

let libsPromise: Promise<PdfLibs> | null = null;

/** pdf.js and its viewer components, loaded once. A dynamic import is required: they touch `window`/workers
 *  at evaluation so they must never load during SSR, and pdf_viewer.mjs reads `globalThis.pdfjsLib` when it evaluates. */
function loadPdfLibs(): Promise<PdfLibs> {
	libsPromise ??= (async () => {
		const pdfjs = await import("pdfjs-dist");
		pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.min.mjs";
		Object.assign(globalThis, { pdfjsLib: pdfjs });
		const viewerLib = await import("pdfjs-dist/web/pdf_viewer.mjs");
		return { pdfjs, viewerLib };
	})().catch((err: unknown) => {
		libsPromise = null;
		throw err;
	});
	return libsPromise;
}

const TEXT_LAYER_WAIT_MS = 8000;
/** Space kept between a highlight's note card and the page edge. */
const POPUP_MARGIN_PX = 8;

/** What the load effect exposes to the imperative handle and the annotation effect. */
interface PdfEngine {
	reveal(target: RevealTarget): Promise<RevealResult>;
	refreshPending(): void;
}

interface PdfStatus {
	/** The load this status belongs to. */
	key: string;
	error?: string;
}

/** PDF: pdf.js viewer (canvas + text layer + native annotation layer). The worker never calls /api: bytes are fetched here. */
export function PdfView({ ref, doc, chatId, initialLocation, annotations, contentVersion, onLocation, onReady }: ViewerViewProps) {
	const t = useT();
	const v = t.chat.viewer;
	const containerRef = useRef<HTMLDivElement>(null);
	const viewerElRef = useRef<HTMLDivElement>(null);
	const engineRef = useRef<PdfEngine | null>(null);
	const [status, setStatus] = useState<PdfStatus>({ key: "" });
	const loadKey = `${chatId}:${doc.id}:${contentVersion}`;
	// The page to restore: the saved one first, then wherever the learner is when the file is reloaded.
	const pageRef = useRef(initialLocation?.page);
	const latest = useRef({ annotations, onLocation, onReady, messages: v });
	useEffect(() => {
		latest.current = { annotations, onLocation, onReady, messages: v };
	});

	useImperativeHandle(ref, () => ({ reveal: (target) => engineRef.current?.reveal(target) ?? Promise.resolve("none") }), []);

	useEffect(() => {
		engineRef.current?.refreshPending();
	}, [annotations]);

	useEffect(() => {
		const container = containerRef.current;
		const viewerEl = viewerElRef.current;
		if (!container || !viewerEl) return;
		const abort = new AbortController();
		let disposed = false;
		let task: PDFDocumentLoadingTask | null = null;
		let viewer: PDFViewer | null = null;
		let observer: ResizeObserver | null = null;
		let frame = 0;

		// pdf.js puts a highlight's note card right of the highlight and never checks that it fits. A line of right-to-left text
		// ends at the page's right margin, so the card spills past the page and is cut off. Once it is shown, shift it left just
		// enough to sit inside the page (and the visible viewer), keeping a small margin.
		const keepPopupInView = (popup: HTMLElement) => {
			const page = popup.closest<HTMLElement>(".page");
			if (!page) return;
			popup.style.translate = "";
			const card = popup.getBoundingClientRect();
			const pageBox = page.getBoundingClientRect();
			const right = Math.min(pageBox.right, container.getBoundingClientRect().left + container.clientWidth) - POPUP_MARGIN_PX;
			const shift = Math.min(Math.max(0, card.right - right), Math.max(0, card.left - (pageBox.left + POPUP_MARGIN_PX)));
			if (shift > 0) popup.style.translate = `${-shift}px 0`;
		};
		const popupWatcher = new MutationObserver((records) => {
			for (const { target } of records) {
				if (target instanceof HTMLElement && target.classList.contains("popupAnnotation") && !target.hidden) keepPopupInView(target);
			}
		});
		popupWatcher.observe(viewerEl, { attributes: true, attributeFilter: ["hidden"], subtree: true });

		void (async () => {
			try {
				const [{ pdfjs, viewerLib }, res] = await Promise.all([
					loadPdfLibs(),
					fetch(documentUrl(chatId, doc, "file"), { signal: abort.signal, cache: "no-store" }),
				]);
				if (!res.ok) throw new ViewLoadError(await loadErrorMessage(res, latest.current.messages, doc));
				const data = new Uint8Array(await res.arrayBuffer());
				if (disposed) return;
				const loadingTask = pdfjs.getDocument({
					data,
					cMapUrl: "/pdfjs/cmaps/",
					cMapPacked: true,
					standardFontDataUrl: "/pdfjs/standard_fonts/",
					wasmUrl: "/pdfjs/wasm/",
					iccUrl: "/pdfjs/iccs/",
				});
				task = loadingTask;
				const pdf = await loadingTask.promise;
				if (disposed) return;

				const { EventBus, PDFLinkService, PDFViewer: Viewer, LinkTarget } = viewerLib;
				const eventBus = new EventBus();
				const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
				const pdfViewer = new Viewer({ container, viewer: viewerEl, eventBus, linkService, textLayerMode: 1 });
				viewer = pdfViewer;
				linkService.setViewer(pdfViewer);

				const textCache = new Map<number, string[]>();
				const layers = new Map<number, HTMLElement>();
				const waiters = new Map<number, (() => void)[]>();
				const pendingRanges = new Map<number, Range[]>();
				let flash: { page: number; quote: string; occurrence: number } | null = null;
				let reporting = false;
				let initialized = false;
				let lastWidth = 0;

				/** The text layer of page `n` once pdf.js finished it (and is still showing it). */
				const layerOf = (n: number): HTMLElement | null => {
					const div = (pdfViewer.getPageView(n - 1)?.textLayer?.div ?? null) as HTMLElement | null;
					return div && layers.get(n) === div && div.isConnected ? div : null;
				};

				/** Underline this page's pending proposals; re-find the flashed passage when it is on this page. */
				const applyPage = (n: number, scroll: boolean): Range | null => {
					const layer = layerOf(n);
					if (!layer) return null;
					const pending = latest.current.annotations.filter((a) => a.status === "pending" && !a.regions && (a.page === undefined || a.page === n));
					pendingRanges.set(n, pending.flatMap((a) => rangesForQuote(layer, a.quote)));
					setHighlight("lh-doc-pending", [...pendingRanges.values()].flat());
					if (flash?.page !== n) return null;
					const matches = rangesForQuote(layer, flash.quote);
					const range = matches[flash.occurrence] ?? matches[0];
					if (!range) return null;
					setHighlight("lh-doc-flash", [range]);
					if (scroll) scrollRangeToCenter(container, range);
					return range;
				};

				const pageStrings = async (n: number): Promise<string[]> => {
					const cached = textCache.get(n);
					if (cached) return cached;
					const page = await pdf.getPage(n);
					const content = await page.getTextContent();
					const strings = content.items.flatMap((item) => ("str" in item ? [item.str] : []));
					textCache.set(n, strings);
					return strings;
				};

				/** First page holding the quote: the hint page first, then the rest in order. */
				const findPage = async (quote: string, hint: number | undefined): Promise<number | null> => {
					const all = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
					const order = hint !== undefined && hint >= 1 && hint <= pdf.numPages ? [hint, ...all.filter((n) => n !== hint)] : all;
					for (const n of order) {
						if (disposed) return null;
						if (locateAll(await pageStrings(n), quote).length > 0) return n;
					}
					return null;
				};

				const waitForLayer = (n: number): Promise<HTMLElement | null> => {
					const { promise, resolve } = Promise.withResolvers<HTMLElement | null>();
					const ready = layerOf(n);
					if (ready) {
						resolve(ready);
						return promise;
					}
					const timer = window.setTimeout(() => resolve(layerOf(n)), TEXT_LAYER_WAIT_MS);
					const list = waiters.get(n) ?? [];
					list.push(() => {
						clearTimeout(timer);
						resolve(layerOf(n));
					});
					waiters.set(n, list);
					return promise;
				};

				const goToPage = (n: number) => {
					pdfViewer.currentPageNumber = Math.min(Math.max(1, n), pdfViewer.pagesCount);
				};

				/** An overlay rectangle on page `n`, in percent of the page so it follows zoom; null while that page's view does not exist. */
				const regionBox = (n: number, className: string, region: PageRegion): HTMLElement | null => {
					const pageEl = pdfViewer.getPageView(n - 1)?.div;
					if (!pageEl) return null;
					const el = document.createElement("div");
					el.className = className;
					el.style.left = `${region.x * 100}%`;
					el.style.top = `${region.y * 100}%`;
					el.style.width = `${region.w * 100}%`;
					el.style.height = `${region.h * 100}%`;
					pageEl.append(el);
					return el;
				};

				/** Page `n`'s pending scanned-page proposals as boxes over the page image (there is no text to underline). */
				const applyBoxes = (n: number) => {
					const pageEl: HTMLElement | undefined = pdfViewer.getPageView(n - 1)?.div;
					pageEl?.querySelectorAll(".lh-annotation-box").forEach((el) => el.remove());
					for (const a of latest.current.annotations) {
						if (a.status !== "pending" || a.page !== n) continue;
						for (const region of a.regions ?? []) regionBox(n, "lh-annotation-box", region);
					}
				};

				/** Outline a screenshot region on page `n` for a moment and bring it to the middle of the view. */
				const flashRegion = (n: number, region: PageRegion) => {
					const el = regionBox(n, "lh-region-flash", region);
					if (!el) return;
					const remove = () => el.remove();
					el.addEventListener("animationend", remove, { once: true });
					window.setTimeout(remove, 3500);
					const box = el.getBoundingClientRect();
					const view = container.getBoundingClientRect();
					container.scrollTop += box.top + box.height / 2 - (view.top + view.height / 2);
				};

				engineRef.current = {
					async reveal(target) {
						setHighlight("lh-doc-flash", []);
						flash = null;
						if (target.region && target.page !== undefined) {
							goToPage(target.page);
							const page = pdfViewer.currentPageNumber;
							await waitForLayer(page);
							if (disposed) return "none";
							flashRegion(page, target.region);
							return "passage";
						}
						if (target.quote) {
							const page = await findPage(target.quote, target.page);
							if (disposed) return "none";
							if (page !== null) {
								flash = { page, quote: target.quote, occurrence: target.occurrence ?? 0 };
								goToPage(page);
								await waitForLayer(page);
								if (disposed) return "none";
								return applyPage(page, true) ? "passage" : "page";
							}
						}
						if (target.page === undefined) return "none";
						goToPage(target.page);
						return "page";
					},
					refreshPending() {
						for (const n of layers.keys()) applyPage(n, false);
						if (initialized) for (let n = 1; n <= pdf.numPages; n++) applyBoxes(n);
					},
				};

				eventBus.on("pagesinit", () => {
					pdfViewer.currentScaleValue = "page-width";
					initialized = true;
					const page = pageRef.current;
					if (page !== undefined && page > 1) goToPage(page);
					reporting = true;
					setStatus({ key: loadKey });
					latest.current.onReady(true);
				});
				eventBus.on("pagechanging", (evt: { pageNumber: number }) => {
					if (!reporting) return;
					pageRef.current = evt.pageNumber;
					latest.current.onLocation({ page: evt.pageNumber });
				});
				eventBus.on("textlayerrendered", (evt: { pageNumber: number; error?: unknown }) => {
					const div = pdfViewer.getPageView(evt.pageNumber - 1)?.textLayer?.div as HTMLElement | undefined;
					if (div && !evt.error) layers.set(evt.pageNumber, div);
					applyPage(evt.pageNumber, false);
					for (const wake of waiters.get(evt.pageNumber) ?? []) wake();
					waiters.delete(evt.pageNumber);
				});
				eventBus.on("pagerendered", (evt: { pageNumber: number }) => applyBoxes(evt.pageNumber));

				observer = new ResizeObserver(() => {
					cancelAnimationFrame(frame);
					frame = requestAnimationFrame(() => {
						const width = container.clientWidth;
						if (!initialized || disposed || width === 0 || width === lastWidth) return;
						lastWidth = width;
						pdfViewer.currentScaleValue = "page-width";
					});
				});
				observer.observe(container);

				pdfViewer.setDocument(pdf);
				linkService.setDocument(pdf, null);
			} catch (err) {
				if (disposed || abort.signal.aborted) return;
				setStatus({ key: loadKey, error: err instanceof ViewLoadError ? err.message : latest.current.messages.unreadable });
			}
		})();

		return () => {
			disposed = true;
			abort.abort();
			cancelAnimationFrame(frame);
			observer?.disconnect();
			popupWatcher.disconnect();
			engineRef.current = null;
			clearHighlights();
			try {
				viewer?.setDocument(null as unknown as PDFDocumentProxy);
			} catch {
				// The viewer was never fully initialized.
			}
			void task?.destroy().catch(() => {});
			latest.current.onReady(false);
		};
	}, [loadKey, chatId, doc.id]);

	return (
		<div className="absolute inset-0 bg-muted/40">
			<div key={loadKey} ref={containerRef} dir="ltr" className="absolute inset-0 overflow-auto">
				<div ref={viewerElRef} className="pdfViewer" />
			</div>
			{(status.key !== loadKey || status.error) && (
				<p
					role={status.error ? "alert" : "status"}
					className="absolute inset-0 grid place-items-center bg-background/80 p-6 text-center text-sm text-muted-foreground"
				>
					{status.key === loadKey ? status.error : v.loading}
				</p>
			)}
		</div>
	);
}
