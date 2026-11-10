import type { PageRegion } from "@/src/core";

export interface RegionReading {
	transcript: string;
	snapshotId: string;
}

/** A refused or failed read; `code` is the machine discriminator when the server sent one. */
export class RegionReadError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

/** Have the scan-reader model read one rectangle of a PDF page (POST …/documents/:id/region). */
export async function readRegion(
	chatId: string,
	documentId: string,
	page: number,
	region: PageRegion,
	signal: AbortSignal,
): Promise<RegionReading> {
	const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/documents/${documentId}/region`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ page, region }),
		signal,
	});
	const body = (await response.json().catch(() => null)) as
		| { error?: string; code?: string; transcript?: unknown; snapshotId?: unknown }
		| null;
	if (!response.ok) throw new RegionReadError(body?.error ?? `HTTP ${response.status}`, body?.code);
	if (typeof body?.transcript !== "string" || typeof body.snapshotId !== "string") {
		throw new RegionReadError("Unexpected response from the server");
	}
	return { transcript: body.transcript, snapshotId: body.snapshotId };
}
