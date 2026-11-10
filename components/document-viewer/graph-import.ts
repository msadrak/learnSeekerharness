import { toast } from "sonner";
import { documentLocus, MODELS_NOT_CONFIGURED_CODE, PROVIDER_KEY_MISSING_CODE, type DocumentExcerpt } from "@/src/core";
import type { Messages } from "@/components/i18n";

/** One row of POST /api/graph/import's `results` (transport shape only). */
interface ImportRow {
	ok: boolean;
	error?: string;
	code?: string;
}

/** The refused-before-any-model-call outcome: models or the provider key are not set up. */
export class ImportRefusedError extends Error {
	constructor(message: string, readonly code: typeof MODELS_NOT_CONFIGURED_CODE | typeof PROVIDER_KEY_MISSING_CODE) {
		super(message);
	}
}

/** File names inside the import path identity: no separators, colons, quotes or controls. */
function safeFileStem(name: string): string {
	const stem = name.replace(/[\\/:"\u0000-\u001f\u007f]/g, "_").trim().slice(0, 200);
	return stem || "document";
}

/**
 * Feed one passage into the notes-import pipeline: one source per document,
 * named after the file, inside the "Document excerpts" folder. Resolves when
 * the extraction run finishes; rejects with a readable Error (an
 * `ImportRefusedError` when the setup flow is the fix).
 */
export async function postExcerptImport(name: string, text: string): Promise<void> {
	const stem = safeFileStem(name);
	const fileName = `${stem}.md`;
	const form = new FormData();
	form.append("files", new File([text], fileName, { type: "text/markdown" }));
	form.append("paths", `Document excerpts/${fileName}`);
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	const body = (await response.json().catch(() => null)) as { results?: ImportRow[]; error?: string } | null;
	if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
	const row = body?.results?.[0];
	if (!row) throw new Error(body?.error ?? `HTTP ${response.status}`);
	if (row.ok) return;
	const message = row.error ?? `HTTP ${response.status}`;
	if (row.code === MODELS_NOT_CONFIGURED_CODE || row.code === PROVIDER_KEY_MISSING_CODE) throw new ImportRefusedError(message, row.code);
	throw new Error(message);
}

/** "Add to graph": toast the progress and outcome; a config refusal offers the setup dialog. */
export function addExcerptToGraph(
	excerpt: DocumentExcerpt,
	messages: Pick<Messages, "chat" | "cards">,
	openSetup: () => void,
): void {
	const v = messages.chat.viewer;
	const text = `${excerpt.name}${documentLocus(excerpt)}:\n\n${excerpt.quote}\n`;
	toast.promise(postExcerptImport(excerpt.name, text), {
		loading: v.graph.adding(excerpt.name),
		success: v.graph.added,
		error: (err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			if (err instanceof ImportRefusedError) {
				const label = err.code === PROVIDER_KEY_MISSING_CODE ? messages.cards.dispatch.addKey : messages.cards.dispatch.setUpModels;
				return { message: v.graph.failed(message), action: { label, onClick: openSetup } };
			}
			return { message: v.graph.failed(message) };
		},
	});
}
