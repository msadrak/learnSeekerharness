"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/components/i18n";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { localizeServerError } from "@/lib/i18n/server-errors";

/** Starred models as `"provider:id"` pins, backed by the `favorites`
 *  settings section. Reads on mount and whenever any writer lands the
 *  section; `toggle` is optimistic and reverts on a failed write. */
export function useFavoriteModels(): { favorites: ReadonlySet<string>; toggle(key: string): void } {
	const t = useT();
	const tRef = useRef(t);
	tRef.current = t;
	const [models, setModels] = useState<readonly string[]>([]);
	const modelsRef = useRef<readonly string[]>([]);
	modelsRef.current = models;

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/settings");
			if (!res.ok) return;
			const body = (await res.json()) as { settings?: { favorites?: { models?: string[] } } };
			setModels(body.settings?.favorites?.models ?? []);
		} catch {
			// Stars are a convenience: a failed read leaves the last known set.
		}
	}, []);

	useEffect(() => { void load(); }, [load]);
	useSettingsSaved((section) => { if (section === "favorites") void load(); });

	const toggle = useCallback((key: string) => {
		const previous = modelsRef.current;
		const next = previous.includes(key) ? previous.filter((k) => k !== key) : [...previous, key];
		modelsRef.current = next;
		setModels(next);
		void (async () => {
			let detail: string;
			try {
				const res = await fetch("/api/settings/favorites", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ models: next }),
				});
				if (res.ok) {
					notifySettingsSaved("favorites");
					return;
				}
				const body = (await res.json().catch(() => ({}))) as { error?: unknown };
				detail = String(body.error ?? res.status);
			} catch (err) {
				detail = err instanceof Error ? err.message : String(err);
			}
			modelsRef.current = previous;
			setModels(previous);
			const tt = tRef.current;
			toast.error(tt.settings.dialog.saveFailed(tt.settings.menus.favorites, localizeServerError(detail, tt)));
		})();
	}, []);

	const favorites = useMemo<ReadonlySet<string>>(() => new Set(models), [models]);
	return { favorites, toggle };
}
