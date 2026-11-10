// A fake OpenAI-compatible chat model that can play several roles at once. The server owns the streaming
// protocol and the request log; a handler module decides what each request gets.
//
//   node scripts/verify-rig/fake-llm.mjs scripts/verify-rig/handlers/annotate.mjs [--port 4010] [--log fake.jsonl]
//
// A handler module's default export is `(request) => reply`:
//   request = { body, messages, toolNames, hasImage, lastRole, lastText, userText }
//     toolNames  names of the tools the caller offered (tell roles apart: the teacher has document tools, a locator has its own)
//     hasImage   a message carries an image (a vision read)
//     lastRole   role of the last message ("tool" means a tool result is waiting for an answer)
//     lastText   text of the last message; userText is the last user message's text parts
//   reply   = { text } | { tool: { name, args } } | undefined (undefined answers "Understood.")
// Decide "answer or call a tool" from `lastRole === "tool"`, never from tool results elsewhere in the history,
// or a second question in the same chat never calls the tool.
import fs from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const handlerPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--port" && args[args.indexOf(a) - 1] !== "--log");
if (!handlerPath) {
	console.error("usage: node scripts/verify-rig/fake-llm.mjs <handlers.mjs> [--port 4010] [--log file.jsonl]");
	process.exit(2);
}
const port = Number(flag("--port", process.env.LH_RIG_FAKE_PORT ?? 4010));
const logFile = flag("--log", process.env.FAKE_LOG);
const respond = (await import(pathToFileURL(path.resolve(handlerPath)).href)).default;

const log = (entry) => logFile && fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : "");

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const textChunks = (text) => [
	{ choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
	{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
];
const toolChunks = ({ name, args: toolArgs }) => [
	{ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(toolArgs) } }] } }] },
	{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
];

function sse(res, chunks) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}

http
	.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
			const body = JSON.parse(raw);
			const messages = body.messages ?? [];
			const last = messages.at(-1);
			const request = {
				body,
				messages,
				toolNames: (body.tools ?? []).map((tool) => tool.function?.name),
				hasImage: messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")),
				lastRole: last?.role,
				lastText: textOf(last?.content),
				userText: textOf(messages.findLast((m) => m.role === "user")?.content),
			};
			const reply = respond(request) ?? { text: "Understood." };
			log({ lastRole: request.lastRole, hasImage: request.hasImage, toolNames: request.toolNames, reply: "tool" in reply ? { tool: reply.tool.name } : { text: String(reply.text).slice(0, 200) } });
			sse(res, "tool" in reply ? toolChunks(reply.tool) : textChunks(reply.text));
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`fake llm on ${port}, handlers ${handlerPath}`));
