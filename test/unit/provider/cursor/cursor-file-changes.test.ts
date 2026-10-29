// Failure modes: creation reported as an edit, deleted files dropped, failed
// tools treated as writes, and reconciled snapshots losing provider text.
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { CursorTurnEvents } from "../../../../src/lib/provider/cursor/cursor-turn-events.js";
import { createMockEventSink } from "../../../helpers/mock-sdk.js";

function completedDelta(fixture: string): Record<string, unknown> {
	const rows: { kind: string; data?: Record<string, unknown> }[] = readFileSync(
		`test/fixtures/cursor-sdk-traces/${fixture}.jsonl`,
		"utf8",
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const delta = rows.find(
		(row) =>
			row.kind === "delta" && row.data?.["type"] === "tool-call-completed",
	)?.data;
	if (!delta) throw new Error(`Missing tool completion in ${fixture}`);
	return delta;
}

function captureEvents() {
	const emitted: ProviderRuntimeEvent[] = [];
	const events = new CursorTurnEvents(
		"parent",
		"message",
		{
			...createMockEventSink(),
			push: (event) =>
				Effect.sync(() => {
					emitted.push(event);
				}),
		},
		process.cwd(),
		{ ensure: () => Effect.void },
	);
	return { emitted, events };
}

const workspace = "/home/test/src/personal/cursor-spike/ws";
const addPatch = `--- /dev/null\n+++ b/${workspace}/a.txt\n@@ -1,0 +1 @@\n+hi`;
const updatePatch = `--- a/${workspace}/edit-me.txt\n+++ b/${workspace}/edit-me.txt\n@@ -1 +1 @@\n-before\n+after`;

describe("Cursor Tool File Change", () => {
	it.each([
		["tool-edit", { path: `${workspace}/a.txt`, kind: "add", patch: addPatch }],
		["tool-write", { path: "created.txt", kind: "add", after: "created\n" }],
		["tool-delete", { path: `${workspace}/delete-me.txt`, kind: "delete" }],
	])("records captured %s completion", async (fixture, fileChange) => {
		const { emitted, events } = captureEvents();
		await Effect.runPromise(events.delta(completedDelta(String(fixture))));
		const completed = emitted.find((event) => event.type === "tool.completed");
		expect(completed?.data).toMatchObject({
			outcome: "succeeded",
			fileChanges: [fileChange],
		});
	});

	it("preserves captured reconciled changes in events and snapshots", async () => {
		const { emitted, events } = captureEvents();
		await Effect.runPromise(events.delta(completedDelta("subagent-reconcile")));
		const changes = [
			{ path: `${workspace}/a.txt`, kind: "add", patch: addPatch, after: "hi" },
			{
				path: `${workspace}/delete-me.txt`,
				kind: "delete",
				before: "delete\n",
			},
			{
				path: `${workspace}/edit-me.txt`,
				kind: "update",
				patch: updatePatch,
				before: "before\n",
				after: "after",
			},
		];
		const completed = emitted.filter(
			(event) => event.type === "tool.completed",
		);
		for (const change of changes) {
			expect(completed.map((event) => event.data)).toContainEqual(
				expect.objectContaining({ fileChanges: [change] }),
			);
		}
		const snapshot = emitted.find((event) => event.type === "message.snapshot");
		expect(snapshot?.data).toMatchObject({
			message: {
				parts: expect.arrayContaining(
					changes.map((change) =>
						expect.objectContaining({
							type: "tool",
							state: expect.objectContaining({ fileChanges: [change] }),
						}),
					),
				),
			},
		});
	});

	it.each([
		"edit",
		"write",
		"delete",
	])("omits File Change for failed %s", async (type) => {
		const { emitted, events } = captureEvents();
		await Effect.runPromise(
			events.delta({
				type: "tool-call-completed",
				callId: "failed",
				toolCall: {
					type,
					args: { path: "denied.txt", fileText: "must not persist" },
					result: { status: "error", error: { message: "Denied" } },
				},
			}),
		);
		const completed = emitted.find((event) => event.type === "tool.completed");
		expect(completed?.data).toMatchObject({ outcome: "failed" });
		expect(completed?.data).not.toHaveProperty("fileChanges");
	});
});
