import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import type { ModelRole } from "../../config.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { ROLE_SLOT, type ModelSlotName } from "../core/settings.ts";
import { stores } from "./stores.ts";

/** The settings-resolved engine for one role — BYOK (owner, 2026-09-22):
 *  the chain (role override → slot → NOTHING) may end empty, and undefined
 *  flows through to the per-need refusal gates (runner/extraction/region
 *  transcription), read FRESH so a settings PUT between dispatch and spawn lands. */
export function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec, true, undefined, retentionForSlot(ROLE_SLOT[role])) : undefined;
}

/** Slot policy is independent of model overrides. Read fresh per operation,
 * including parked conversations, background loops and compaction. */
export function retentionForSlot(slot: ModelSlotName) {
	return () => stores.settingsStore.readSettings()?.models?.[slot]?.cacheRetention;
}
