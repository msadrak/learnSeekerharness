/**
 * Fixtures for scripts/smoke-visual.mjs: three graph propositions plus one
 * practice chat whose clean `problem` targets the first proposition and whose
 * clean `conclude` is "solved" — so the graph renders one Understood node.
 * Run under the smoke script's LH_DATA_DIR; never touches the real data dir.
 */
import { graphStore } from "../../src/store/graph.ts";
import { chatStore } from "../../src/store/chats.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../../src/core/native-messages.ts";

if (!process.env.LH_DATA_DIR) throw new Error("seed-visual: LH_DATA_DIR must point at a temporary data dir");

const createdAt = new Date("2026-10-28T00:00:00.000Z").toISOString();
const names = ["Addition", "Subtraction", "Multiplication"];
// The chat exists first so every proposition can carry provenance pointing at
// it — that is what gives the command palette a session per proposition.
const chat = chatStore.createChat("Practice fixture", "practice");
const nodes = names.map((name, i) => ({
	id: `n_visual_${i}`,
	name,
	statement: `${name} is a basic arithmetic operation.`,
	aliases: [],
	createdAt,
	provenance: [{ chatId: chat.id, messageId: "m_problem" }],
}));
for (const node of nodes) graphStore.appendNode(node);

// The graph view draws only nodes that have a persisted position (normally
// written by the layout settle after an extraction run).
graphStore.writePositions(Object.fromEntries(nodes.map((node, i) => [node.id, { x: (i - 1) * 140, y: i % 2 === 0 ? 0 : 90 }])));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id: string, toolCallId: string, name: string, args: Record<string, unknown>, timestamp: number) => ({
	id,
	role: "assistant" as const,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "synthetic",
	timestamp,
	stopReason: "toolUse" as const,
	usage,
	content: [{ type: "toolCall" as const, id: toolCallId, name, arguments: args }],
});
const ack = (id: string, toolCallId: string, toolName: string) => ({
	id,
	role: "toolResult" as const,
	toolCallId,
	toolName,
	content: [{ type: "text" as const, text: "ok" }],
	details: null,
	isError: false,
	timestamp: 0,
});
const messages = [
	assistant("m_problem", "call_problem", PRACTICE_PROBLEM_TOOL, { statement: "Compute 1 + 1.", mode: "recall", target: [nodes[0]!.id] }, 1000),
	ack("m_problem_ack", "call_problem", PRACTICE_PROBLEM_TOOL),
	assistant("m_conclude", "call_conclude", PRACTICE_CONCLUDE_TOOL, { outcome: "solved", retest: false }, 2000),
	ack("m_conclude_ack", "call_conclude", PRACTICE_CONCLUDE_TOOL),
] as unknown as LhMessage[];
chatStore.saveMessages(chat.id, messages);
console.log(JSON.stringify({ nodes: nodes.length, chat: chat.id }));
