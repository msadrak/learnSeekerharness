/**
 * Multi-select session deletion: the sequential runner (partial failure must
 * not stop the run, every failure is reported, graph revision = newest) and
 * the confirmation dialog's pure body.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BulkDeleteBody, runBulkDelete } from "../components/bulk-delete-sessions-dialog.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import type { ChatListItem } from "../src/core/index.ts";

type Reply = { status: number; body: unknown } | "network";

function fakeFetch(replies: Record<string, Reply>, calls: string[] = []): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${url}`);
		const id = url.split("/api/chats/")[1]!.split("?")[0]!;
		const reply = replies[id];
		if (reply === "network" || reply === undefined) throw new TypeError("network down");
		return new Response(JSON.stringify(reply.body), { status: reply.status });
	}) as typeof fetch;
}

describe("runBulkDelete", () => {
	it("deletes one by one with the chosen mode, reports progress, keeps the newest revision", async () => {
		const calls: string[] = [];
		const progress: Array<[number, number]> = [];
		const result = await runBulkDelete(
			["a", "b", "c"],
			"delete-nodes",
			(done, total) => progress.push([done, total]),
			fakeFetch(
				{
					a: { status: 200, body: { ok: true, graphRevision: 4 } },
					b: { status: 200, body: { ok: true, graphRevision: 9 } },
					c: { status: 200, body: { ok: true, graphRevision: 7 } },
				},
				calls,
			),
		);
		assert.deepEqual(calls, [
			"DELETE /api/chats/a?mode=delete-nodes",
			"DELETE /api/chats/b?mode=delete-nodes",
			"DELETE /api/chats/c?mode=delete-nodes",
		]);
		assert.deepEqual(result, { deleted: ["a", "b", "c"], failed: [], graphRevision: 9 });
		assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
	});

	it("a refused or unreachable session never stops the rest; failures keep the server's reason", async () => {
		const result = await runBulkDelete(
			["a", "b", "c", "d"],
			"preserve-graph",
			undefined,
			fakeFetch({
				a: { status: 409, body: { error: "A turn is running in this session — try again when it finishes", code: "turn_in_flight" } },
				b: { status: 200, body: { ok: true, graphRevision: 2 } },
				c: "network",
				d: { status: 500, body: {} },
			}),
		);
		assert.deepEqual(result.deleted, ["b"]);
		assert.equal(result.graphRevision, 2);
		assert.deepEqual(result.failed, [
			{ id: "a", code: "turn_in_flight", error: "A turn is running in this session — try again when it finishes", status: 409 },
			{ id: "c", code: "network" },
			{ id: "d", code: "error", error: undefined, status: 500 },
		]);
	});
});

describe("BulkDeleteBody", () => {
	const chats = [
		{ id: "a", title: "Alpha" },
		{ id: "b", title: "Beta" },
	];
	const noop = () => {};

	it("titles the count, lists the sessions, and the graph-traces box starts unchecked", () => {
		const html = renderToStaticMarkup(
			<BulkDeleteBody chats={chats} traces={false} progress={null} failures={[]} attempted={0} onTraces={noop} onClose={noop} onRun={noop} />,
		);
		assert.match(html, /Delete 2 sessions\?/);
		assert.match(html, /Alpha/);
		assert.match(html, /Beta/);
		assert.match(html, /data-testid="bulk-delete-traces-checkbox"(?![^>]*checked)/);
		assert.doesNotMatch(html, /bulk-delete-failure/);
	});

	it("while running the confirm shows progress and everything is locked", () => {
		const html = renderToStaticMarkup(
			<BulkDeleteBody chats={chats} traces progress={{ done: 1, total: 2 }} failures={[]} attempted={2} onTraces={noop} onClose={noop} onRun={noop} />,
		);
		assert.match(html, /Deleting… 1\/2/);
		for (const id of ["bulk-delete-confirm", "bulk-delete-cancel", "bulk-delete-traces-checkbox"]) {
			assert.match(html, new RegExp(`data-testid="${id}"[^>]*disabled`), id);
		}
	});

	it("partial failure lists each session with its reason and turns Delete into Try again", () => {
		const html = renderToStaticMarkup(
			<BulkDeleteBody
				chats={[chats[0]!]}
				traces={false}
				progress={null}
				failures={[{ id: "a", title: "Alpha", message: "A turn is running" }]}
				attempted={2}
				onTraces={noop}
				onClose={noop}
				onRun={noop}
			/>,
		);
		assert.match(html, /1 of 2 sessions couldn’t be deleted and stays selected\./);
		assert.match(html, /Alpha<\/span> — <span[^>]*>A turn is running/);
		assert.match(html, /Try again/);
	});
});

describe("SessionRow in selection mode", () => {
	const chat: ChatListItem = {
		id: "c1",
		title: "Junk chat",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 1,
		phase: "probe",
		pendingQuestion: false,
		busy: false,
	} as ChatListItem;

	it("shows a checkbox and exposes the checked state to assistive tech", () => {
		const off = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} selectMode selected={false} />);
		const on = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} selectMode selected />);
		assert.match(off, /data-testid="session-row-check"/);
		assert.match(off, /aria-pressed="false"/);
		assert.match(on, /aria-pressed="true"/);
		assert.match(on, /aria-label="Select Junk chat"/);
	});

	it("outside selection mode there is no checkbox and no pressed state", () => {
		const html = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} />);
		assert.doesNotMatch(html, /session-row-check|aria-pressed/);
	});
});
