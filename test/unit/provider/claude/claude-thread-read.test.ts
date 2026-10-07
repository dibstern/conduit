import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeEventStoreEffect } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makeEffectSqlMigrator } from "../../../../src/lib/persistence/effect/migrations.js";
import { makeProjectionRunnerEffect } from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../../../src/lib/persistence/effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "../../../../src/lib/persistence/effect/projectors-effect.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../../src/lib/persistence/events.js";
import { makeClaudeThreadRead } from "../../../../src/lib/provider/claude/claude-thread-read.js";

// Failure modes: wrong order; cursor skips/repeats; truncation without an offset;
// unclamped limit; dropped content leaks; errors fail the turn; runner opens SQLite.
// Exercise the server handler over the real event store and transcript query.
it("reads ordered, filtered history with bounded pages and recoverable errors", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const store = yield* makeEventStoreEffect;
			const cursors = yield* makeProjectorCursorEffect;
			const projector = yield* makeProjectionRunnerEffect(
				createAllEffectProjectors(),
			).pipe(Effect.provideService(ProjectorCursorEffectTag, cursors));
			yield* projector.recover();
			const longText = `${"x".repeat(19_999)}🧪long tail`;
			const mixedText = [
				"Visible text",
				"Visible error",
				"Visible interruption",
				"File change: visible.ts",
				"Visible plan",
				"Command: printf visible\nExit code: 7\nVisible command output",
				"File change: written.ts",
				"Visible tool plan",
			].join("\n");
			const messages = Array.from({ length: 110 }, (_, index) => ({
				id: `m${String(index).padStart(4, "0")}`,
				text:
					index === 1 ? longText : index === 2 ? mixedText : `Message ${index}`,
			}));
			const events: CanonicalEvent[] = [
				...["s1", "s2", "empty"].map((sessionId) =>
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: "Thread",
						provider: "claude",
					}),
				),
			];
			for (const [index, message] of messages.entries()) {
				const parts =
					index === 2
						? [
								{ type: "text", text: "Visible text" },
								{ type: "error", text: "Visible error" },
								{ type: "interrupted", text: "Visible interruption" },
								{ type: "file_change", text: "visible.ts" },
								{ type: "plan", text: "Visible plan" },
								{
									type: "tool",
									tool: "Bash",
									state: {
										input: { command: "printf visible" },
										output: { exitCode: 7, output: "Visible command output" },
									},
								},
								{
									type: "tool",
									tool: "Write",
									state: {
										input: { file_path: "written.ts", content: "PRIVATE_DIFF" },
										output: "PRIVATE_WRITE_RESULT",
									},
								},
								{
									type: "tool",
									tool: "ExitPlanMode",
									state: {
										input: { plan: "Visible tool plan" },
										output: "PRIVATE_PLAN_RESULT",
									},
								},
								{ type: "reasoning", text: "PRIVATE_REASONING" },
								{
									type: "tool",
									tool: "Read",
									state: {
										input: { file_path: "PRIVATE_READ" },
										output: "PRIVATE_TOOL_RESULT",
									},
								},
								{
									type: "tool",
									tool: "Grep",
									state: {
										input: { pattern: "PRIVATE_SEARCH" },
										output: "PRIVATE_SEARCH_RESULT",
									},
								},
								{ type: "diff", text: "PRIVATE_DIFF" },
								{
									type: "file",
									filename: "PRIVATE_ATTACHMENT",
									url: "PRIVATE_URL",
								},
							]
						: [{ type: "text", text: message.text }];
				events.push(
					canonicalEvent("message.snapshot", "s1", {
						messageId: message.id,
						digest: message.id,
						message: {
							id: message.id,
							sessionID: "s1",
							role: index === 0 ? "user" : "assistant",
							time: { created: 1000 + Math.floor(index / 2) },
							...(index === 2 ? { finish: "interrupted" } : {}),
							parts: parts.map((part, partIndex) => ({
								...part,
								id: `${message.id}:p${partIndex}`,
							})),
						},
					}),
				);
			}
			events.push(
				canonicalEvent("message.created", "s2", {
					messageId: "foreign",
					sessionId: "s2",
					role: "user",
				}),
			);
			yield* projector.projectBatch(yield* store.appendBatch(events));
			const readQuery = yield* makeReadQueryEffect;
			const read = yield* makeClaudeThreadRead.pipe(
				Effect.provideService(ReadQueryEffectTag, readQuery),
			);
			expect(yield* read("s1", { limit: 1 })).toEqual({
				items: [
					{
						id: "m0000",
						role: "user",
						text: "Message 0",
						textOffset: 0,
						interrupted: false,
					},
				],
				nextCursor: "m0001",
			});
			const longPage = yield* read("s1", { cursor: "m0001", limit: 2 });
			expect(longPage).toEqual({
				items: [
					{
						id: "m0001",
						role: "assistant",
						text: "x".repeat(19_999),
						textOffset: 0,
						interrupted: false,
					},
				],
				nextCursor: "m0001",
				nextTextOffset: 19_999,
			});
			expect(
				yield* read("s1", { cursor: "m0001", textOffset: 19_999, limit: 2 }),
			).toEqual({
				items: [
					{
						id: "m0001",
						role: "assistant",
						text: "🧪long tail",
						textOffset: 19_999,
						interrupted: false,
					},
					{
						id: "m0002",
						role: "assistant",
						text: mixedText,
						textOffset: 0,
						interrupted: true,
					},
				],
				nextCursor: "m0003",
			});
			const collected = new Map<string, string>();
			let cursor: string | undefined;
			let textOffset: number | undefined;
			for (let pageIndex = 0; pageIndex < 120; pageIndex++) {
				const result = yield* read("s1", { cursor, textOffset, limit: 3 });
				if (!("items" in result)) throw new Error(result.message);
				expect(
					result.items.reduce((total, item) => total + item.text.length, 0),
				).toBeLessThanOrEqual(20_000);
				for (const item of result.items) {
					expect(item.text).not.toContain("PRIVATE_");
					expect(item.textOffset).toBe(collected.get(item.id)?.length ?? 0);
					collected.set(item.id, (collected.get(item.id) ?? "") + item.text);
				}
				cursor = result.nextCursor;
				textOffset = result.nextTextOffset;
				if (cursor === undefined) break;
			}
			expect([...collected]).toEqual(
				messages.map(({ id, text }) => [id, text]),
			);
			const defaultPage = yield* read("s1", { cursor: "m0003" });
			expect(defaultPage).toMatchObject({ nextCursor: "m0053" });
			expect("items" in defaultPage && defaultPage.items.length).toBe(50);
			const maxPage = yield* read("s1", { cursor: "m0003", limit: 1000 });
			expect(maxPage).toMatchObject({ nextCursor: "m0103" });
			expect("items" in maxPage && maxPage.items.length).toBe(100);
			for (const badCursor of ["missing", "foreign", ""]) {
				expect(yield* read("s1", { cursor: badCursor })).toEqual({
					code: "BadCursor",
					message: expect.any(String),
				});
			}
			for (const offset of [-1, 0.5, longText.length + 1]) {
				expect(
					yield* read("s1", { cursor: "m0001", textOffset: offset }),
				).toEqual({
					code: "InvalidOffset",
					message: expect.any(String),
				});
			}
			expect(yield* read("empty", {})).toEqual({ items: [] });
			expect(yield* read("gone", {})).toEqual({
				code: "SessionGone",
				message: expect.any(String),
			});
			const sql = yield* SqlClient.SqlClient;
			yield* sql`DROP TABLE messages`;
			expect(yield* read("s1", {})).toEqual({
				code: "ServerUnavailable",
				message: expect.any(String),
			});
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	);
});
