"use client";
/**
 * The /api/keys state shared by the Providers, Dictation and Search
 * sections: masked statuses + the provider catalog, and the save/delete
 * actions (PUT/DELETE /api/keys/:id). Plaintext never returns from the
 * store; every write re-reads and broadcasts the "keys" settings signal so
 * the zero-keys pill, the setup dialog and the model pickers hear it.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { AuthKeyStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useT } from "@/components/i18n";
import type { ProviderKeyInfo } from "./keys-section.tsx";

interface KeysResponse {
	keys: AuthKeyStatus[];
	providers?: ProviderKeyInfo[];
}

export interface KeyStatuses {
	/** null while the first load is in flight. */
	statuses: AuthKeyStatus[] | null;
	providers: ProviderKeyInfo[] | undefined;
	/** The last /api/keys read failed (statuses is [] then). */
	failed: boolean;
	reload(): Promise<void>;
	/** Resolves null on success or the server's error text. A `label` adds
	 *  the success toast. */
	save(id: string, value: string, label?: string): Promise<string | null>;
	/** A `label` adds the success toast. */
	remove(id: string, label?: string): Promise<void>;
}

export function useKeyStatuses(): KeyStatuses {
	const t = useT();
	const ts = t.settings.toasts;
	const [statuses, setStatuses] = useState<AuthKeyStatus[] | null>(null);
	const [providers, setProviders] = useState<ProviderKeyInfo[] | undefined>(undefined);
	const [failed, setFailed] = useState(false);

	const reload = useCallback(async () => {
		try {
			const body = (await fetch("/api/keys").then((r) => r.json())) as KeysResponse;
			setStatuses(body.keys ?? []);
			if (body.providers) setProviders(body.providers);
			setFailed(false);
		} catch {
			setStatuses([]);
			setFailed(true);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const save = useCallback(
		async (id: string, value: string, label?: string): Promise<string | null> => {
			const res = await fetch(`/api/keys/${id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				return body.error ?? t.settings.keys.saveFailed(res.status);
			}
			await reload();
			// The cross-surface keys signal (zero-keys wave): the zero-keys pill,
			// the setup dialog's stage advance, and any other keys reader hear
			// that a key landed — deletions included (see remove below).
			notifySettingsSaved("keys");
			if (label !== undefined) toast.success(ts.keySaved(label));
			return null;
		},
		[reload, t, ts],
	);

	const remove = useCallback(
		async (id: string, label?: string): Promise<void> => {
			const res = await fetch(`/api/keys/${id}`, { method: "DELETE" }).catch(() => undefined);
			await reload();
			notifySettingsSaved("keys");
			if (res?.ok && label !== undefined) toast.success(ts.keyDeleted(label));
		},
		[reload, ts],
	);

	return { statuses, providers, failed, reload, save, remove };
}
