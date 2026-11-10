/**
 * The scan page cache (data/scan-cache/<id>.json): a scanned PDF page the scan
 * reader has read is stored once, verbatim, so later sections, questions and
 * sessions never pay for it again. One file per document identity; atomic
 * read-modify-write (sync, so parallel page reads in one process never
 * interleave). No expiry, and a model change does not invalidate old pages —
 * each page records which model read it.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { SessionDocument } from "../core/documents.ts";
import type { ScanCachedPage, ScanPageCache } from "../core/scan-section.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const ID_RE = /^[a-f0-9]{64}$/;

/** A document's cache identity: the content hash for uploads, else path + size + mtime (an edited file starts fresh). */
export function scanCacheId(doc: SessionDocument, file: string): string {
	if (doc.source.kind === "upload") return doc.source.sha256;
	const stat = fs.statSync(file);
	return createHash("sha256").update(`${path.resolve(file)}\0${stat.size}\0${stat.mtimeMs}`).digest("hex");
}

function cacheFile(id: string): string {
	if (!ID_RE.test(id)) throw new Error(`Invalid scan cache id: ${id}`);
	return path.join(PATHS.scanCache, `${id}.json`);
}

function isEntry(value: unknown): value is ScanCachedPage {
	if (typeof value !== "object" || value === null) return false;
	const o = value as Record<string, unknown>;
	return typeof o.text === "string" && typeof o.model === "string" && typeof o.at === "string";
}

/** Every stored page; an absent, corrupt or foreign-shaped file reads as empty (nothing is rewritten until the next put). */
function readPages(id: string): Record<string, ScanCachedPage> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(cacheFile(id), "utf-8"));
	} catch {
		return {};
	}
	const pages = typeof parsed === "object" && parsed !== null ? (parsed as { pages?: unknown }).pages : undefined;
	if (typeof pages !== "object" || pages === null) return {};
	return Object.fromEntries(Object.entries(pages).filter(([key, value]) => /^[0-9]+$/.test(key) && isEntry(value))) as Record<string, ScanCachedPage>;
}

export function openScanCache(id: string): ScanPageCache {
	return {
		get: (page) => readPages(id)[String(page)],
		put(page, entry) {
			const pages = readPages(id);
			pages[String(page)] = entry;
			fs.mkdirSync(PATHS.scanCache, { recursive: true });
			writeFileAtomicSync(cacheFile(id), `${JSON.stringify({ version: 1, pages }, null, "\t")}\n`, { allowInPlaceFallback: true });
		},
	};
}
