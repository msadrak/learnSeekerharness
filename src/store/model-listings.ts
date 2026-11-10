/**
 * The saved model listings (data/model-listings/<providerId>.json): the answer a provider last fetched from its
 * service, stored as received so the provider's current parser reads it again after a restart or hot reload. A
 * listing holds model names and limits only — nothing secret. An absent, corrupt or foreign-shaped file reads as
 * "nothing saved" and is replaced by the next write.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { ModelListingStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function listingFile(providerId: string): string {
	if (!PROVIDER_ID_RE.test(providerId)) throw new Error(`Invalid provider id for a model listing: ${providerId}`);
	return path.join(PATHS.modelListings, `${providerId}.json`);
}

export const modelListingStore: ModelListingStore = {
	read(providerId) {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(listingFile(providerId), "utf-8"));
			return typeof parsed === "object" && parsed !== null && "listing" in parsed ? parsed.listing : undefined;
		} catch {
			return undefined;
		}
	},
	write(providerId, listing) {
		fs.mkdirSync(PATHS.modelListings, { recursive: true });
		writeFileAtomicSync(listingFile(providerId), `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), listing }, null, "\t")}\n`, { allowInPlaceFallback: true });
	},
};
