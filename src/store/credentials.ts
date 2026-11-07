/**
 * The file-backed pi-ai CredentialStore (subscriptions wave): one
 * `{providerId: Credential}` map at config.CREDENTIALS_FILE holding OAuth
 * subscription logins and custom-provider API keys. Mode 0600, atomic
 * tmp+rename writes, re-read from disk on every access (hand-edits and a
 * second process's writes are seen; the file is tiny).
 *
 * pi-ai's contract: `modify` is the ONLY write path and must be a serialized
 * read-modify-write (Models runs OAuth refresh inside it so a rotated
 * refresh token is never double-spent). One PROCESS-WIDE chain serializes
 * every write — the whole file is rewritten per write, so per-provider
 * chains would lose updates across providers. The chain is anchored on
 * globalThis (HMR / per-route bundles re-import this module; they must
 * share one queue).
 *
 * Never throws on read: absent/corrupt file = "no credentials yet" (the
 * documented first-boot state, matching auth.json); entries that do not
 * look like a credential are dropped on read and survive untouched on disk
 * until the next write of the file rewrites without them.
 */

import fs from "node:fs";
import path from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { CREDENTIALS_FILE } from "../../config.ts";

type CredentialMap = Record<string, Credential>;

function looksLikeCredential(v: unknown): v is Credential {
	if (!v || typeof v !== "object" || !("type" in v)) return false;
	if (v.type === "api_key") return !("key" in v) || v.key === undefined || typeof v.key === "string";
	if (v.type === "oauth") {
		return "access" in v && typeof v.access === "string" && "refresh" in v && typeof v.refresh === "string" && "expires" in v && typeof v.expires === "number";
	}
	return false;
}

function readMap(): CredentialMap {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
		if (!raw || typeof raw !== "object" || !("credentials" in raw)) return {};
		const entries = raw.credentials;
		if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {};
		const out: CredentialMap = {};
		for (const [id, v] of Object.entries(entries)) if (looksLikeCredential(v)) out[id] = v;
		return out;
	} catch {
		return {};
	}
}

function writeMap(map: CredentialMap): void {
	const dir = path.dirname(CREDENTIALS_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.credentials.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, credentials: map }, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, CREDENTIALS_FILE);
}

const QUEUE_KEY = Symbol.for("lh.credentialQueue");
function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const g = globalThis as Record<symbol, Promise<unknown> | undefined>;
	const run = (g[QUEUE_KEY] ?? Promise.resolve()).then(task, task);
	g[QUEUE_KEY] = run.catch(() => undefined);
	return run;
}

export interface FileCredentialStore extends CredentialStore {
	/** Sync, secret-free presence probe — the picker/catalog gates on it
	 *  (their callers are sync). Returns the credential's type, or undefined. */
	typeOf(providerId: string): Credential["type"] | undefined;
	/** Sync account/status enumeration without secrets. */
	listSync(): CredentialInfo[];
	/** Sync read for the custom-provider auth resolver (request-time). */
	readSync(providerId: string): Credential | undefined;
	/** Sync mtime+size stamp (cache key for credential-dependent caches). */
	stamp(): string;
}

export const credentialStore: FileCredentialStore = {
	async read(providerId) {
		return readMap()[providerId];
	},
	async list() {
		return this.listSync();
	},
	modify(providerId, fn, options) {
		return enqueue(async () => {
			options?.signal?.throwIfAborted();
			const map = readMap();
			const next = await fn(map[providerId]);
			if (next === undefined) return map[providerId];
			map[providerId] = next;
			writeMap(map);
			return next;
		});
	},
	delete(providerId) {
		return enqueue(async () => {
			const map = readMap();
			if (!(providerId in map)) return;
			delete map[providerId];
			writeMap(map);
		});
	},
	typeOf(providerId) {
		return readMap()[providerId]?.type;
	},
	listSync() {
		return Object.entries(readMap()).map(([providerId, c]) => ({ providerId, type: c.type }));
	},
	readSync(providerId) {
		return readMap()[providerId];
	},
	stamp() {
		try {
			const s = fs.statSync(CREDENTIALS_FILE);
			return `${s.mtimeMs}:${s.size}`;
		} catch {
			return "absent";
		}
	},
};
