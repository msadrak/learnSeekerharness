import type { Messages } from "@/components/i18n";
import type { SelectionGate } from "./viewer-context";

/** What a screenshot region can be sent as: Explain / Quiz me go at once, Quote waits for the next message. */
export type RegionAction = "explain" | "quiz" | "quote";

/** Why sending a selection as a message is unavailable right now (localized), or null. */
export function sendBlockedReason(gate: SelectionGate, s: Messages["chat"]["viewer"]["selection"]): string | null {
	if (gate.busy) return s.busyHint;
	if (gate.pendingQuestion) return s.pendingHint;
	if (gate.activeProblem) return s.problemHint;
	return null;
}
