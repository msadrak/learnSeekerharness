/**
 * Practice mastery — the graph's per-proposition "how did the last practice
 * go" signal. DERIVED on every read from the practice chats' clean conclude
 * calls (no ledger, nothing stored): the latest conclusion that targeted a
 * proposition decides its state.
 *
 * Pure and browser-safe; the snapshot (core/graph.ts) feeds it the chats.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolveTargetId } from "./chains.ts";
import type { GraphNode, MasteryState, PropositionMastery } from "./contracts/graph.ts";
import {
	cleanToolCallIds,
	PRACTICE_CONCLUDE_TOOL,
	problemInputForConclude,
	type LhMessage,
} from "./native-messages.ts";

export type PracticeOutcome = "solved" | "solvedWithHints" | "movedOn" | "surrendered";

const OUTCOMES: readonly PracticeOutcome[] = ["solved", "solvedWithHints", "movedOn", "surrendered"];

/** One clean practice conclusion, resolved to the proposition ids it targeted. */
export interface PracticeVerdict {
	nodeIds: string[];
	outcome: PracticeOutcome;
	retest: boolean;
	/** Epoch ms of the concluding assistant message. */
	at: number;
	chatId: string;
}

/** Outcome → state. Giving up always needs review; hints or a retest keep
 *  the proposition in progress; only an unaided first-pass solve is understood. */
export function masteryState(outcome: PracticeOutcome, retest: boolean): MasteryState {
	if (outcome === "movedOn" || outcome === "surrendered") return "needsReview";
	if (outcome === "solvedWithHints") return "inProgress";
	if (outcome === "solved" && retest) return "inProgress";
	return "understood";
}

/** Every clean, non-dismissed conclude of one chat whose pose targeted at
 *  least one known proposition. A conclude counts only through its clean
 *  ack (the honest-activation law); a problem without a clean ack folds no
 *  target, so its conclude yields nothing. */
export function practiceVerdicts(
	chatId: string,
	messages: readonly LhMessage[],
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
): PracticeVerdict[] {
	const clean = cleanToolCallIds(messages);
	const verdicts: PracticeVerdict[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== PRACTICE_CONCLUDE_TOOL || !clean.has(block.id)) continue;
			const args: Record<string, unknown> = block.arguments ?? {};
			const outcome = OUTCOMES.find((o) => o === args.outcome);
			if (outcome === undefined) continue;
			const target = problemInputForConclude(messages, block.id)?.target;
			const targets = Array.isArray(target) ? target.filter((t): t is string => typeof t === "string") : [];
			const nodeIds = new Set<string>();
			for (const t of targets) {
				const id = resolveTargetId(t, nodes);
				if (id !== null) nodeIds.add(id);
			}
			if (nodeIds.size === 0) continue;
			verdicts.push({
				nodeIds: [...nodeIds],
				outcome,
				retest: args.retest === true,
				at: message.timestamp,
				chatId,
			});
		}
	}
	return verdicts;
}

/** proposition id → its latest verdict (largest `at`; a tie goes to the
 *  later one in iteration order). */
export function deriveMastery(verdicts: Iterable<PracticeVerdict>): Record<string, PropositionMastery> {
	const latest = new Map<string, PracticeVerdict>();
	for (const verdict of verdicts) {
		for (const id of verdict.nodeIds) {
			const prev = latest.get(id);
			if (prev === undefined || verdict.at >= prev.at) latest.set(id, verdict);
		}
	}
	const out: Record<string, PropositionMastery> = {};
	for (const [id, v] of latest) {
		Object.defineProperty(out, id, {
			value: { state: masteryState(v.outcome, v.retest), at: new Date(v.at).toISOString(), chatId: v.chatId },
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return out;
}
