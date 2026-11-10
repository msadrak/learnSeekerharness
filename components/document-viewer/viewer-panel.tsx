"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { BookOpenIcon, CropIcon, DownloadIcon, FileTextIcon, FolderOpenIcon, XIcon } from "lucide-react";
import { DOCUMENT_FORMAT_LABEL, type DocumentFormat, type SessionDocument } from "@/src/core";
import { DOCUMENT_ACCEPT } from "@/lib/document-limits";
import { downloadFile } from "@/components/artifacts/download";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { textDirection } from "@/lib/i18n/direction";
import { cn } from "@/lib/utils";
import { AnnotationStrip } from "./annotation-strip";
import { DocxView } from "./docx-view";
import { MarkdownView } from "./markdown-view";
import { PdfView } from "./pdf-view";
import { RegionTool } from "./region-tool";
import { SelectionMenu } from "./selection-menu";
import { documentUrl, type ViewerViewHandle } from "./view-handle";
import { useDocumentViewer, type DocumentViewerApi } from "./viewer-context";

const MIME: Record<DocumentFormat, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	markdown: "text/markdown; charset=utf-8",
};

const VIEWS = { pdf: PdfView, docx: DocxView, markdown: MarkdownView } as const;

/**
 * The document viewer panel: tabs, header actions, the agent banner, the
 * active document's view, the annotation strip, drag & drop. It fills its
 * parent (Chat sizes and places it). Renders nothing outside `Chat`.
 */
export function DocumentViewerPanel({ chatId }: { chatId: string }) {
	const viewer = useDocumentViewer();
	return viewer ? <ViewerPanelBody viewer={viewer} chatId={chatId} /> : null;
}

function ViewerPanelBody({ viewer, chatId }: { viewer: DocumentViewerApi; chatId: string }) {
	const t = useT();
	const v = t.chat.viewer;
	const { state, banner } = viewer;
	const fileInput = useRef<HTMLInputElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<ViewerViewHandle>(null);
	const dragDepth = useRef(0);
	const [dragging, setDragging] = useState(false);
	/** The document whose view is rendered and revealable. */
	const [readyId, setReadyId] = useState<string | null>(null);
	/** The document whose header region toggle is on (a tab switch turns it off). */
	const [regionFor, setRegionFor] = useState<string | null>(null);

	const tabs = state.tabs.flatMap((id) => state.documents.find((d) => d.id === id) ?? []);
	const active = tabs.find((d) => d.id === state.activeId) ?? null;
	const activeId = active?.id ?? null;

	const annotations = useMemo(
		() => state.annotations.filter((a) => a.documentId === activeId),
		[state.annotations, activeId],
	);
	// A written annotation changed the file on disk: PDF and Markdown reload it.
	const contentVersion = useMemo(() => annotations.filter((a) => a.status === "accepted").map((a) => a.id).join(","), [annotations]);

	// A reveal waits until the active document's view can act on it.
	const { pendingReveal, consumeReveal } = viewer;
	useEffect(() => {
		if (!pendingReveal || activeId === null || pendingReveal.target.documentId !== activeId || readyId !== activeId) return;
		const handle = viewRef.current;
		if (!handle) return;
		consumeReveal(pendingReveal.seq);
		const { quote } = pendingReveal.target;
		void handle.reveal(pendingReveal.target).then((result) => {
			if (result === "none" && quote) toast(v.passageNotFound);
		});
	}, [pendingReveal, activeId, readyId, consumeReveal, v.passageNotFound]);

	const openFile = async (file: File) => {
		// Desktop: the file stays where it is; browser: it is uploaded.
		const path = window.lh?.getPathForFile?.(file);
		if (path) await viewer.openPath(path);
		else await viewer.upload(file);
	};

	const download = async (doc: SessionDocument) => {
		try {
			const res = await fetch(documentUrl(chatId, doc, "file"));
			if (!res.ok) throw new Error(String(res.status));
			downloadFile(doc.name, new Uint8Array(await res.arrayBuffer()), MIME[doc.format]);
		} catch {
			toast.error(v.unreadable);
		}
	};

	const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
	const View = active ? VIEWS[active.format] : null;
	const bannerDoc = banner ? state.documents.find((d) => d.id === banner.target.documentId) : undefined;

	return (
		<section
			aria-label={v.toggle}
			data-testid="document-viewer-panel"
			className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background"
			onDragEnter={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.stopPropagation(); // the transcript's path drop zone must not also react
				dragDepth.current++;
				setDragging(true);
			}}
			onDragOver={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(event) => {
				if (!hasFiles(event)) return;
				event.stopPropagation();
				dragDepth.current = Math.max(0, dragDepth.current - 1);
				if (dragDepth.current === 0) setDragging(false);
			}}
			onDrop={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.stopPropagation();
				dragDepth.current = 0;
				setDragging(false);
				const files = Array.from(event.dataTransfer.files);
				void (async () => {
					for (const file of files) await openFile(file);
				})();
			}}
		>
			<input
				ref={fileInput}
				type="file"
				accept={DOCUMENT_ACCEPT}
				multiple
				className="hidden"
				data-testid="viewer-file-input"
				onChange={(event) => {
					const files = Array.from(event.currentTarget.files ?? []);
					event.currentTarget.value = ""; // allow re-picking the same file
					void (async () => {
						for (const file of files) await openFile(file);
					})();
				}}
			/>

			{/* The panel spans the session area top to bottom beside the TopBar: same h-15 band, same
			    window-drag/controls-gutter behavior (natives carve themselves out of the drag region). */}
			<header className="lh-drag lh-wco-gutter flex h-15 shrink-0 items-center gap-1 border-b bg-card/60 px-1.5">
				<div role="tablist" aria-label={v.toggle} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
					{tabs.map((doc) => {
						const selected = doc.id === activeId;
						return (
							<div
								key={doc.id}
								role="presentation"
								className={cn(
									"flex max-w-52 shrink-0 items-center rounded-md border border-transparent",
									selected ? "border-border bg-background shadow-soft" : "hover:bg-accent/50",
								)}
							>
								<button
									type="button"
									role="tab"
									aria-selected={selected}
									title={`${doc.name} · ${DOCUMENT_FORMAT_LABEL[doc.format]}`}
									onClick={() => viewer.setActive(doc.id)}
									className="flex min-w-0 items-center gap-1.5 rounded-md py-1 ps-2 pe-1 text-start text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
								>
									<FileTextIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
									<span dir={textDirection(doc.name)} className={cn("truncate", selected ? "text-foreground" : "text-muted-foreground")}>
										{doc.name}
									</span>
								</button>
								<button
									type="button"
									aria-label={v.closeTab(doc.name)}
									title={v.closeTab(doc.name)}
									onClick={() => viewer.closeTab(doc.id)}
									className="me-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
								>
									<XIcon aria-hidden="true" className="size-3" />
								</button>
							</div>
						);
					})}
				</div>
				{active?.format === "pdf" && (
					<Hint label={v.region.toggle} side="bottom">
						<Button
							type="button"
							size="icon-sm"
							variant={regionFor === active.id ? "secondary" : "ghost"}
							aria-label={v.region.toggle}
							aria-pressed={regionFor === active.id}
							data-testid="region-toggle"
							onClick={() => setRegionFor(regionFor === active.id ? null : active.id)}
						>
							<CropIcon aria-hidden="true" />
						</Button>
					</Hint>
				)}
				<Hint label={v.open} side="bottom">
					<Button type="button" size="icon-sm" variant="ghost" aria-label={v.open} onClick={() => fileInput.current?.click()}>
						<FolderOpenIcon aria-hidden="true" />
					</Button>
				</Hint>
				{active?.source.kind === "upload" && (
					<Hint label={v.download} side="bottom">
						<Button type="button" size="icon-sm" variant="ghost" aria-label={v.download} onClick={() => void download(active)}>
							<DownloadIcon aria-hidden="true" />
						</Button>
					</Hint>
				)}
				<Hint label={v.closePanel} side="bottom">
					<Button type="button" size="icon-sm" variant="ghost" aria-label={v.closePanel} onClick={() => viewer.setPanelOpen(false)}>
						<XIcon aria-hidden="true" />
					</Button>
				</Hint>
			</header>

			{banner && (
				<div
					role="status"
					data-testid="viewer-banner"
					className="flex shrink-0 items-center gap-2 border-b bg-brand/10 px-3 py-1.5 text-xs"
				>
					<span className="min-w-0 flex-1 truncate" title={bannerDoc?.name}>
						{banner.kind === "point"
							? v.banner.points(bannerDoc?.name ?? "", banner.target.page)
							: v.banner.opened(bannerDoc?.name ?? "")}
					</span>
					<Button
						type="button"
						size="xs"
						variant="secondary"
						onClick={() => {
							viewer.reveal(banner.target);
							viewer.dismissBanner();
						}}
					>
						{v.banner.go}
					</Button>
					<Button type="button" size="icon-xs" variant="ghost" aria-label={v.banner.dismiss} title={v.banner.dismiss} onClick={viewer.dismissBanner}>
						<XIcon aria-hidden="true" />
					</Button>
				</div>
			)}

			{viewer.error && (
				<div role="alert" className="flex shrink-0 items-center gap-2 border-b bg-danger/10 px-3 py-1.5 text-xs text-danger">
					<span className="min-w-0 flex-1">{viewer.error}</span>
					<Button type="button" size="icon-xs" variant="ghost" aria-label={v.banner.dismiss} title={v.banner.dismiss} onClick={viewer.clearError}>
						<XIcon aria-hidden="true" />
					</Button>
				</div>
			)}

			<div ref={bodyRef} className="relative min-h-0 flex-1">
				{active && View ? (
					<>
						<View
							key={`view-${active.id}`}
							ref={viewRef}
							doc={active}
							chatId={chatId}
							initialLocation={state.positions[active.id]}
							annotations={annotations}
							contentVersion={contentVersion}
							onLocation={(loc) => viewer.reportPosition(active.id, loc)}
							onReady={(ready) => setReadyId(ready ? active.id : null)}
						/>
						<SelectionMenu key={`menu-${active.id}`} doc={active} bodyRef={bodyRef} />
						{active.format === "pdf" && (
							<RegionTool
								key={`region-${active.id}`}
								doc={active}
								chatId={chatId}
								bodyRef={bodyRef}
								active={regionFor === active.id}
								onExit={() => setRegionFor(null)}
							/>
						)}
					</>
				) : (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
						<BookOpenIcon aria-hidden="true" className="size-8 text-muted-foreground" />
						<p className="font-ui text-sm font-medium">{v.empty}</p>
						<p className="max-w-xs text-xs text-muted-foreground">{v.emptyHint}</p>
						<Button type="button" size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
							<FolderOpenIcon aria-hidden="true" />
							{v.open}
						</Button>
					</div>
				)}
			</div>

			{active && <AnnotationStrip documentId={active.id} />}

			{dragging && (
				<div
					data-testid="viewer-drop-indicator"
					className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/85 p-6 text-center backdrop-blur-sm"
				>
					<span className="font-ui text-sm">{v.dropHere}</span>
				</div>
			)}
		</section>
	);
}
