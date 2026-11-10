/**
 * The custom-providers composition (custom-providers wave): CRUD over the
 * user-declared model endpoints behind /api/providers, and the registration
 * of the agent layer's ProviderSource (credential store + custom providers).
 *
 * Importing this module installs the source (idempotent, like keys.ts's
 * boot fill-gap) — every route/handler path reaches it through the server
 * barrel, so piModels() always resolves custom providers and stored
 * credentials by the time an engine is built.
 *
 * The endpoint's key (API key or bearer token) is a SECRET: it lives in the
 * credential store as `{type:"api_key"}` under the provider id, never in
 * providers.json, and is never returned — views carry only `hasKey`.
 */

import { buildCustomProvider } from "../agent/custom-provider-factory.ts";
import { registerProviderSource, reservedProviderIds } from "../agent/models.ts";
import { validateCustomProvider, type CustomProviderDef } from "../core/custom-providers.ts";
import { credentialStore } from "../store/credentials.ts";
import { customProviderStore } from "../store/custom-providers.ts";
import { modelListingStore } from "../store/model-listings.ts";

/** A definition plus whether a key is stored (never the key). */
export interface CustomProviderView extends CustomProviderDef {
	hasKey: boolean;
}

export type CustomProviderWrite = { ok: true; provider: CustomProviderView } | { ok: false; error: string };

export function customProviderDefs(): CustomProviderDef[] {
	return customProviderStore.read(reservedProviderIds());
}

export function customProviderIds(): Set<string> {
	return new Set(customProviderDefs().map((d) => d.id));
}

function view(def: CustomProviderDef): CustomProviderView {
	return { ...def, hasKey: credentialStore.typeOf(def.id) === "api_key" };
}

export function customProviderViews(): CustomProviderView[] {
	return customProviderDefs().map(view);
}

/** Key paste hygiene: no whitespace/control chars, sane length. */
function keyProblem(key: string): string | null {
	if (key.length === 0 || key.length > 4096 || /[\s\u0000-\u001f]/.test(key)) {
		return "key must be 1-4096 characters with no whitespace";
	}
	return null;
}

/**
 * Create or replace one provider (upsert by id).
 * `apiKey`: undefined = leave the stored key alone; null or "" = clear it;
 * a string = store it. The definition is validated BEFORE anything is
 * written, so a bad body never half-applies.
 */
export async function saveCustomProvider(raw: unknown, apiKey?: string | null): Promise<CustomProviderWrite> {
	const verdict = validateCustomProvider(raw, reservedProviderIds());
	if (!verdict.ok) return verdict;
	const key = typeof apiKey === "string" ? apiKey.trim() : apiKey;
	if (typeof key === "string" && key.length > 0) {
		const problem = keyProblem(key);
		if (problem) return { ok: false, error: problem };
	}
	const def = verdict.value;
	const others = customProviderDefs().filter((d) => d.id !== def.id);
	customProviderStore.write([...others, def].sort((a, b) => a.id.localeCompare(b.id)));
	if (typeof key === "string" && key.length > 0) {
		await credentialStore.modify(def.id, async () => ({ type: "api_key", key }));
	} else if (key === null || key === "") {
		if (credentialStore.typeOf(def.id) === "api_key") await credentialStore.delete(def.id);
	}
	return { ok: true, provider: view(def) };
}

/** Remove a provider and its stored key. Idempotent. Only ever deletes an
 *  api_key credential: a custom id can never collide with an OAuth provider
 *  (reserved ids), but the guard keeps that invariant local. */
export async function removeCustomProvider(id: string): Promise<boolean> {
	const defs = customProviderDefs();
	if (!defs.some((d) => d.id === id)) return false;
	customProviderStore.write(defs.filter((d) => d.id !== id));
	if (credentialStore.typeOf(id) === "api_key") await credentialStore.delete(id);
	return true;
}

registerProviderSource({
	credentials: credentialStore,
	stamp: () => customProviderStore.stamp(),
	providers: () => customProviderDefs().map(buildCustomProvider),
	listings: modelListingStore,
});
