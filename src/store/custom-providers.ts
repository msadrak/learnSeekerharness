/**
 * The custom-providers file adapter (custom-providers wave): the
 * hand-declared model endpoints at config.CUSTOM_PROVIDERS_FILE. NON-SECRET
 * (credentials live in the credential store). Read from disk on every access
 * so hand-edits take effect; a corrupt or absent file = no custom providers
 * (the documented first-boot state); individually invalid entries are
 * dropped by the pure parser, the rest survive. Atomic tmp+rename writes.
 */

import fs from "node:fs";
import path from "node:path";
import { CUSTOM_PROVIDERS_FILE } from "../../config.ts";
import { parseCustomProvidersFile, type CustomProviderDef, type CustomProvidersFile } from "../core/custom-providers.ts";

export const customProviderStore = {
	read(reservedIds: ReadonlySet<string>): CustomProviderDef[] {
		try {
			return parseCustomProvidersFile(JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_FILE, "utf-8")), reservedIds);
		} catch {
			return [];
		}
	},
	write(providers: readonly CustomProviderDef[]): void {
		const body: CustomProvidersFile = { version: 1, providers: [...providers] };
		const dir = path.dirname(CUSTOM_PROVIDERS_FILE);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = path.join(dir, `.providers.json.tmp-${process.pid}`);
		fs.writeFileSync(tmp, `${JSON.stringify(body, null, "\t")}\n`);
		fs.renameSync(tmp, CUSTOM_PROVIDERS_FILE);
	},
	/** Sync mtime+size stamp — the hot-reload change detector. */
	stamp(): string {
		try {
			const s = fs.statSync(CUSTOM_PROVIDERS_FILE);
			return `${s.mtimeMs}:${s.size}`;
		} catch {
			return "absent";
		}
	},
};
