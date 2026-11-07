/**
 * Practice mastery derivation (src/core/mastery.ts) — the graph's
 * per-proposition "latest practice verdict": outcome → state mapping, the
 * clean-ack discipline, target resolution (id or name) and latest-wins
 * across chats.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { deriveMastery, masteryState, practiceVerdicts } from "../src/core/mastery.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../src/core/native-messages.ts";

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

const NODES = [
	{ id: "n_a", name: "Alpha" },
	{ id: "n_b", name: "Beta" },
];

function call(id: string, name: string, args: JsonObject, timestamp: number): LhMessage & AssistantMessage {
	return {
		id: `msg_a_${id}`,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp,
		...STAMPS,
	};
}

function ack(id: string, name: string, isError = false): LhMessage & ToolResultMessage {
	return {
		id: `msg_r_${id}`,
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		details: null,
		isError,
		timestamp: 0,
	};
}

/** A clean pose targeting `target`, then a clean conclude at `at`. */
function practice(opts: {
	target?: string[];
	outcome: string;
	retest?: boolean;
	at: number;
	problemClean?: boolean;
	concludeClean?: boolean;
	suffix?: string;
}): LhMessage[] {
	const s = opts.suffix ?? "1";
	const args: JsonObject = { outcome: opts.outcome };
	if (opts.retest !== undefined) args.retest = opts.retest;
	return [
		call(`p_${s}`, PRACTICE_PROBLEM_TOOL, { statement: "Show…", mode: "recall", target: opts.target ?? ["n_a"] }, opts.at - 1),
		ack(`p_${s}`, PRACTICE_PROBLEM_TOOL, opts.problemClean === false),
		call(`c_${s}`, PRACTICE_CONCLUDE_TOOL, args, opts.at),
		ack(`c_${s}`, PRACTICE_CONCLUDE_TOOL, opts.concludeClean === false),
	];
}

function masteryOf(messages: LhMessage[], chatId = "chat_1") {
	return deriveMastery(practiceVerdicts(chatId, messages, NODES));
}

describe("masteryState", () => {
	it("solved → understood", () => assert.equal(masteryState("solved", false), "understood"));
	it("solvedWithHints → inProgress", () => assert.equal(masteryState("solvedWithHints", false), "inProgress"));
	it("solved + retest → inProgress", () => assert.equal(masteryState("solved", true), "inProgress"));
	it("movedOn + retest → needsReview", () => assert.equal(masteryState("movedOn", true), "needsReview"));
	it("surrendered → needsReview", () => assert.equal(masteryState("surrendered", false), "needsReview"));
});

describe("practiceVerdicts + deriveMastery", () => {
	it("a clean solved conclude marks its target understood, stamped with the conclude time and chat", () => {
		const out = masteryOf(practice({ outcome: "solved", at: 5000 }));
		assert.deepEqual(out, { n_a: { state: "understood", at: new Date(5000).toISOString(), chatId: "chat_1" } });
	});

	it("reads outcome and retest from the conclude arguments", () => {
		assert.equal(masteryOf(practice({ outcome: "solvedWithHints", at: 10 })).n_a?.state, "inProgress");
		assert.equal(masteryOf(practice({ outcome: "solved", retest: true, at: 10 })).n_a?.state, "inProgress");
		assert.equal(masteryOf(practice({ outcome: "movedOn", retest: true, at: 10 })).n_a?.state, "needsReview");
		assert.equal(masteryOf(practice({ outcome: "surrendered", at: 10 })).n_a?.state, "needsReview");
	});

	it("a dismissed conclude produces no entry", () => {
		assert.deepEqual(masteryOf(practice({ outcome: "dismissed", at: 10 })), {});
	});

	it("an unknown outcome produces no entry", () => {
		assert.deepEqual(masteryOf(practice({ outcome: "nailedIt", at: 10 })), {});
	});

	it("a conclude without a clean ack produces no entry", () => {
		assert.deepEqual(masteryOf(practice({ outcome: "solved", at: 10, concludeClean: false })), {});
	});

	it("a problem not acked by a clean toolResult folds no target → no entry", () => {
		assert.deepEqual(masteryOf(practice({ outcome: "solved", at: 10, problemClean: false })), {});
	});

	it("a target given as a node NAME resolves to the id; unknown targets are ignored", () => {
		const out = masteryOf(practice({ outcome: "solved", at: 10, target: ["Beta", "no-such-node"] }));
		assert.deepEqual(Object.keys(out), ["n_b"]);
		assert.deepEqual(masteryOf(practice({ outcome: "solved", at: 10, target: ["no-such-node"] })), {});
	});

	it("a problem with no target yields no entry", () => {
		const messages = practice({ outcome: "solved", at: 10 });
		(messages[0] as AssistantMessage).content = [
			{ type: "toolCall", id: "p_1", name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "Show…", mode: "recall" } },
		];
		assert.deepEqual(masteryOf(messages), {});
	});

	it("one conclude covers every target of its problem", () => {
		const out = masteryOf(practice({ outcome: "solved", at: 10, target: ["n_a", "Beta"] }));
		assert.deepEqual(Object.keys(out).sort(), ["n_a", "n_b"]);
	});

	it("within one chat the later conclude decides", () => {
		const messages = [
			...practice({ outcome: "surrendered", at: 100, suffix: "1" }),
			...practice({ outcome: "solved", at: 200, suffix: "2" }),
		];
		assert.equal(masteryOf(messages).n_a?.state, "understood");
	});

	it("across two chats the later timestamp wins, whatever the iteration order", () => {
		const older = practiceVerdicts("chat_old", practice({ outcome: "solved", at: 100 }), NODES);
		const newer = practiceVerdicts("chat_new", practice({ outcome: "surrendered", at: 200 }), NODES);
		for (const order of [[older, newer], [newer, older]]) {
			const out = deriveMastery(order.flat());
			assert.equal(out.n_a?.state, "needsReview");
			assert.equal(out.n_a?.chatId, "chat_new");
			assert.equal(out.n_a?.at, new Date(200).toISOString());
		}
	});
});
