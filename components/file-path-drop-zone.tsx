"use client";

import { useEffect, useRef, useState } from "react";
import { FileSymlinkIcon, XIcon } from "lucide-react";
import { directoryReferencePath, quoteFilePath } from "@/src/core";
import { appendToPrimaryInput } from "@/components/dictation";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { useT } from "@/components/i18n";

/** The content area only: the sidebar is deliberately outside this zone.
 * Existing files stay where they are; only quoted path strings enter drafts. */
export function FilePathDropZone({ children, className }: { children: React.ReactNode; className?: string }) {
	const t = useT();
	const root = useRef<HTMLElement>(null);
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	const [notice, setNotice] = useState("");
	const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
	const clearDrag = () => { depth.current = 0; setDragging(false); };
	useEffect(() => {
		// The sidebar remains a non-target, but dropping a file there must not
		// navigate the app away. No indicator or attachment is produced there.
		const preventOutsideNavigation = (event: DragEvent) => {
			if (Array.from(event.dataTransfer?.types ?? []).includes("Files")
				&& event.target instanceof Node && !root.current?.contains(event.target)) event.preventDefault();
		};
		window.addEventListener("dragover", preventOutsideNavigation);
		window.addEventListener("drop", preventOutsideNavigation);
		return () => {
			window.removeEventListener("dragover", preventOutsideNavigation);
			window.removeEventListener("drop", preventOutsideNavigation);
		};
	}, []);
	return (
		<main
			ref={root}
			className={className}
			data-testid="file-path-drop-zone"
			onDragEnter={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				depth.current++;
				setDragging(true);
				setNotice("");
			}}
			onDragOver={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(event) => {
				if (!hasFiles(event)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setDragging(false);
			}}
			onDragEnd={clearDrag}
			onDrop={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.stopPropagation();
				clearDrag();
				const resolve = window.lh?.getPathForFile;
				if (!resolve) { setNotice(t.shell.attach.browserNotice); return; }
				// Inspect only the dropped item's type, never traverse its entries.
				// Positively known directories get a durable trailing separator.
				const entries = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
				const paths: string[] = [];
				let skipped = 0;
				for (const [index, file] of Array.from(event.dataTransfer.files).entries()) {
					try {
						let directory = false;
						try { directory = entries[index]?.webkitGetAsEntry?.()?.isDirectory === true; }
						catch { /* Unknown type stays unmarked, not guessed. */ }
						const original = resolve(file);
						const path = directory ? directoryReferencePath(original) : original;
						quoteFilePath(path); // Same rooted-path validity rule as typed chips.
						paths.push(path);
					} catch { skipped++; }
				}
				if (paths.length === 0) {
					setNotice(t.shell.attach.noLocalPaths);
					return;
				}
				const focused = document.activeElement?.closest<HTMLElement>("[data-file-path-input]");
				if (focused && event.currentTarget.contains(focused)) {
					focused.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
				} else if (!appendToPrimaryInput(paths.map(quoteFilePath).join(" "))) {
					setNotice(t.shell.attach.openChat);
					return;
				}
				setNotice(skipped ? t.shell.attach.somePathsUnavailable : "");
			}}
		>
			{children}
			{dragging && (
				<div data-testid="file-path-drop-indicator" className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/85 p-6 text-center backdrop-blur-sm">
					<div className="flex max-w-md flex-col items-center gap-3">
						<FileSymlinkIcon className="size-8 text-brand" aria-hidden />
						<span className="font-ui text-sm">{window.lh?.getPathForFile ? t.shell.attach.dropPaths : t.shell.attach.browserNotice}</span>
					</div>
				</div>
			)}
			{notice && <div role="status" className="absolute bottom-2 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-xl border bg-popover px-3 py-2 font-ui text-xs shadow-float">
				<span>{notice}</span>
				<button type="button" aria-label={t.shell.attach.dismissNotice} onClick={() => setNotice("")} className="shrink-0 rounded-md p-1 transition-colors hover:bg-accent"><XIcon className="size-3" aria-hidden /></button>
			</div>}
		</main>
	);
}
