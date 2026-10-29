// Failure modes: decoding loses provider kinds, multiple files collapse, moves
// lose their old path, failed or interrupted tools claim writes, and snapshots
// discard completed changes when reconciling the transcript.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { decodeNotification } from "../../../../src/lib/provider/codex/app-server/protocol.js";
import {
	type CodexItemState,
	mapCodexItem,
	settleCodexItems,
} from "../../../../src/lib/provider/codex/codex-item-mapper.js";

const initial: CodexItemState = {
	sessionId: "session",
	turnId: "turn",
	messageId: "message",
	providerId: "codex",
	threadId: "thread",
	now: 1,
	sequence: 0,
	parts: [],
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function apply(state: CodexItemState, method: string, params: unknown) {
	const decoded = decodeNotification({ method, params });
	if (decoded._tag !== "known") throw new Error(`Invalid ${method} fixture`);
	return mapCodexItem(state, decoded);
}

function fileItem(changes: readonly unknown[], status = "completed") {
	return {
		threadId: "thread",
		turnId: "turn",
		item: { type: "fileChange", id: "files", changes, status },
	};
}

describe("Codex Tool File Change", () => {
	it("preserves each file from the captured app-server file-change trace", () => {
		const rows = readFileSync(
			new URL(
				"../../../fixtures/codex-app-server-traces/turn-file-change.jsonl",
				import.meta.url,
			),
			"utf8",
		)
			.trim()
			.split("\n")
			.map(
				(
					line,
				): {
					message?: { method?: string; params?: { item?: { type?: string } } };
				} => JSON.parse(line),
			);
		let state = initial;
		const events: ProviderRuntimeEvent[] = [];
		for (const { message } of rows) {
			if (message?.params?.item?.type !== "fileChange" || !message.method)
				continue;
			const [next, emitted] = apply(state, message.method, message.params);
			state = next;
			events.push(...emitted);
		}
		expect(events.filter(({ type }) => type === "tool.completed")).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					fileChanges: [
						{
							path: "/workspace/alpha.txt",
							kind: "add",
							before: "",
							after: "alpha\n",
						},
						{
							path: "/workspace/beta.txt",
							kind: "add",
							before: "",
							after: "beta\n",
						},
					],
				}),
			}),
		]);
	});

	it("preserves updates, deletions and moves without parsing provider patches", () => {
		const [, events] = apply(
			initial,
			"item/completed",
			fileItem([
				{
					path: "updated.txt",
					kind: { type: "update", move_path: null },
					diff: "@@ -1 +1 @@\n-old\n+new",
				},
				{
					path: "deleted.txt",
					kind: { type: "delete" },
					diff: "deleted contents\n",
				},
				{
					path: "old.txt",
					kind: { type: "update", move_path: "new.txt" },
					diff: "@@ -1 +1 @@\n-old\n+new\n\nMoved to: new.txt",
				},
			]),
		);
		expect(events.at(-1)).toMatchObject({
			type: "tool.completed",
			data: {
				fileChanges: [
					{
						path: "updated.txt",
						kind: "update",
						patch: "@@ -1 +1 @@\n-old\n+new",
					},
					{
						path: "deleted.txt",
						kind: "delete",
						before: "deleted contents\n",
						after: "",
					},
					{
						path: "new.txt",
						oldPath: "old.txt",
						kind: "move",
						patch: "@@ -1 +1 @@\n-old\n+new\n\nMoved to: new.txt",
					},
				],
			},
		});
	});

	it.each([
		"failed",
		"declined",
	])("does not report file changes for %s tools", (status) => {
		const [, events] = apply(
			initial,
			"item/completed",
			fileItem(
				[{ path: "failed.txt", kind: { type: "add" }, diff: "never written" }],
				status,
			),
		);
		expect(events.at(-1)?.data).toHaveProperty("fileChanges", []);
	});

	it("does not claim unfinished writes when settling an interrupted tool", () => {
		const [started] = apply(
			initial,
			"item/started",
			fileItem(
				[
					{
						path: "unfinished.txt",
						kind: { type: "add" },
						diff: "not confirmed",
					},
				],
				"inProgress",
			),
		);
		const [, events] = settleCodexItems(started);
		expect(events.at(-1)?.data).toHaveProperty("fileChanges", []);
	});

	it("retains typed changes in a transcript snapshot", () => {
		const [completed] = apply(
			initial,
			"item/completed",
			fileItem([
				{ path: "new.txt", kind: { type: "add" }, diff: "new contents" },
			]),
		);
		const [streamed] = apply(completed, "item/agentMessage/delta", {
			threadId: "thread",
			turnId: "turn",
			itemId: "text",
			delta: "streamed",
		});
		const [, events] = apply(streamed, "item/completed", {
			threadId: "thread",
			turnId: "turn",
			item: { type: "agentMessage", id: "text", text: "reconciled" },
		});
		expect(
			events.find(({ type }) => type === "message.snapshot"),
		).toMatchObject({
			data: {
				message: {
					parts: [
						expect.objectContaining({
							type: "tool",
							state: expect.objectContaining({
								fileChanges: [
									{
										path: "new.txt",
										kind: "add",
										before: "",
										after: "new contents",
									},
								],
							}),
						}),
						expect.anything(),
					],
				},
			},
		});
	});

	it("still decodes file changes from older app-server data without kind", () => {
		const [, events] = apply(
			initial,
			"item/completed",
			fileItem([{ path: "legacy.txt", diff: "@@ -1 +1 @@\n-old\n+new" }]),
		);
		expect(events.at(-1)).toMatchObject({
			data: {
				fileChanges: [
					{
						path: "legacy.txt",
						kind: "update",
						patch: "@@ -1 +1 @@\n-old\n+new",
					},
				],
			},
		});
	});
});
