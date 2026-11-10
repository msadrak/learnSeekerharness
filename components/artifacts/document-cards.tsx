"use client";

import { useEffect, useRef } from "react";
import { BookOpenIcon, CheckIcon, XIcon } from "lucide-react";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { PassageChip, PassageQuote } from "@/components/document-viewer/passage-parts";
import { useDocumentViewer, type DocumentViewerApi } from "@/components/document-viewer/viewer-context";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { textDirection } from "@/lib/i18n/direction";
import type {
	AnnotationProposalDetails,
	ArtifactPartProps,
	DocumentAnnotation,
	OpenDocumentDetails,
	PassageDetails,
} from "@/src/core";

/**
 * The document-tool cards: open_document ("Opened X" + Go), point_to_passage
 * (the quoted passage + a chip that jumps the viewer there) and
 * propose_annotation (the proposal with its live decision state). The card's
 * data is the tool result's `details` (the part's output). Anything that is
 * not output-available, or whose details are malformed, keeps the quiet
 * tool-call card. On mount a card tells the viewer the call settled (refresh
 * state); open/point cards also raise the viewer banner. Outside Chat
 * (no viewer context) the cards render without their actions.
 */

const FORMATS = ["pdf", "docx", "markdown"];

function isOpenDetails(value: unknown): value is OpenDocumentDetails {
	const v = value as Partial<OpenDocumentDetails> | null | undefined;
	return (
		typeof v?.documentId === "string" &&
		typeof v.name === "string" &&
		FORMATS.includes(v.format as string) &&
		(v.page === undefined || typeof v.page === "number")
	);
}

function isPassageDetails(value: unknown): value is PassageDetails {
	const v = value as Partial<PassageDetails> | null | undefined;
	return (
		typeof v?.documentId === "string" &&
		typeof v.name === "string" &&
		FORMATS.includes(v.format as string) &&
		typeof v.quote === "string" &&
		(v.page === undefined || typeof v.page === "number") &&
		(v.occurrence === undefined || typeof v.occurrence === "number") &&
		(v.note === undefined || typeof v.note === "string")
	);
}

function isProposalDetails(value: unknown): value is AnnotationProposalDetails {
	const v = value as Partial<AnnotationProposalDetails> | null | undefined;
	return (
		typeof v?.annotationId === "string" &&
		typeof v.documentId === "string" &&
		typeof v.name === "string" &&
		FORMATS.includes(v.format as string) &&
		typeof v.quote === "string" &&
		typeof v.note === "string" &&
		(v.page === undefined || typeof v.page === "number")
	);
}

/** Runs `effect` once per mount with the latest viewer (the context object
 *  changes on every state update; the effect must not). */
function useOnMount(viewer: DocumentViewerApi | null, effect: (viewer: DocumentViewerApi) => void) {
	const latest = useRef({ viewer, effect });
	latest.current = { viewer, effect };
	useEffect(() => {
		const { viewer: v, effect: run } = latest.current;
		if (v) run(v);
	}, []);
}

export function DocumentOpenCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available" || !isOpenDetails(part.output)) return <ToolCallCard part={part} />;
	return <OpenCardBody toolCallId={part.toolCallId} details={part.output} />;
}

function OpenCardBody({ toolCallId, details }: { toolCallId: string; details: OpenDocumentDetails }) {
	const t = useT();
	const viewer = useDocumentViewer();
	useOnMount(viewer, (v) => {
		v.toolSettled(toolCallId);
		v.announce(toolCallId, { documentId: details.documentId, page: details.page }, "open");
	});
	return (
		<div
			data-testid="document-open-card"
			className="my-2 flex w-full max-w-2xl items-center gap-2 rounded-xl border bg-card px-4 py-2.5 text-sm shadow-soft"
		>
			<BookOpenIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
			<span dir={textDirection(details.name)} className="min-w-0 flex-1 truncate">
				{t.cards.documents.opened(details.name)}
			</span>
			{viewer && (
				<Button
					type="button"
					variant="outline"
					size="xs"
					onClick={() => viewer.reveal({ documentId: details.documentId, page: details.page })}
				>
					{t.cards.documents.go}
				</Button>
			)}
		</div>
	);
}

export function PassageCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available" || !isPassageDetails(part.output)) return <ToolCallCard part={part} />;
	return <PassageCardBody toolCallId={part.toolCallId} details={part.output} />;
}

function PassageCardBody({ toolCallId, details }: { toolCallId: string; details: PassageDetails }) {
	const t = useT();
	const viewer = useDocumentViewer();
	const target = {
		documentId: details.documentId,
		quote: details.quote,
		page: details.page,
		occurrence: details.occurrence,
	};
	useOnMount(viewer, (v) => {
		v.toolSettled(toolCallId);
		v.announce(toolCallId, target, "point");
	});
	const label = details.page !== undefined ? `${details.name} · ${t.chat.viewer.page(details.page)}` : details.name;
	return (
		<div
			data-testid="passage-card"
			className="my-2 w-full max-w-2xl space-y-2 rounded-xl border bg-card px-4 py-3 shadow-soft"
		>
			<div className="text-xs font-medium text-muted-foreground">{t.cards.documents.pointed}</div>
			<PassageQuote quote={details.quote} />
			{details.note && (
				<div dir={textDirection(details.note)} className="text-sm text-muted-foreground">
					{details.note}
				</div>
			)}
			<PassageChip label={label} title={label} onGo={viewer ? () => viewer.reveal(target) : undefined} />
		</div>
	);
}

export function AnnotationProposalCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available" || !isProposalDetails(part.output)) return <ToolCallCard part={part} />;
	return <ProposalCardBody toolCallId={part.toolCallId} details={part.output} />;
}

function ProposalCardBody({ toolCallId, details }: { toolCallId: string; details: AnnotationProposalDetails }) {
	const t = useT();
	const viewer = useDocumentViewer();
	useOnMount(viewer, (v) => v.toolSettled(toolCallId));
	const annotation: DocumentAnnotation | undefined = viewer?.state.annotations.find(
		(a) => a.id === details.annotationId,
	);
	const target = { documentId: details.documentId, quote: details.quote, page: details.page };
	const status = annotation?.status;
	const statusLabel =
		status === "failed"
			? annotation?.failure
				? t.chat.viewer.annotations.failed[annotation.failure]
				: t.cards.documents.status.failed
			: status
				? t.cards.documents.status[status]
				: null;
	const label = details.page !== undefined ? `${details.name} · ${t.chat.viewer.page(details.page)}` : details.name;
	return (
		<div
			data-testid="annotation-proposal-card"
			data-status={status}
			className="my-2 w-full max-w-2xl space-y-2 rounded-xl border bg-card px-4 py-3 shadow-soft"
		>
			<div className="text-xs font-medium text-muted-foreground">{t.cards.documents.proposal}</div>
			{viewer ? (
				<button
					type="button"
					onClick={() => viewer.reveal(target)}
					className="block w-full cursor-pointer rounded text-start transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<PassageQuote quote={details.quote} />
				</button>
			) : (
				<PassageQuote quote={details.quote} />
			)}
			<div dir={textDirection(details.note)} className="whitespace-pre-wrap break-words text-sm">
				{details.note}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<PassageChip label={label} title={label} onGo={viewer ? () => viewer.reveal(target) : undefined} />
				{statusLabel && (
					<span
						data-testid="annotation-status"
						className={
							status === "failed"
								? "text-xs text-danger"
								: status === "accepted"
									? "text-xs text-success"
									: "text-xs text-muted-foreground"
						}
					>
						{statusLabel}
					</span>
				)}
				{viewer && annotation && status === "pending" && (
					<span className="ms-auto flex items-center gap-1.5">
						<Button
							type="button"
							variant="outline"
							size="xs"
							onClick={() => void viewer.decide([annotation.id], "reject")}
						>
							<XIcon aria-hidden="true" />
							{t.chat.viewer.annotations.reject}
						</Button>
						<Button type="button" size="xs" onClick={() => void viewer.decide([annotation.id], "accept")}>
							<CheckIcon aria-hidden="true" />
							{t.chat.viewer.annotations.accept}
						</Button>
					</span>
				)}
			</div>
			{status === "pending" && annotation?.lastError && (
				<div className="text-xs text-muted-foreground">{annotation.lastError}</div>
			)}
		</div>
	);
}
