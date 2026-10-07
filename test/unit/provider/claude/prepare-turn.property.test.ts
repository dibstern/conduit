import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import fc from "fast-check";
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
	makeProviderStateEffect,
	ProviderStateEffectTag,
} from "../../../../src/lib/persistence/effect/provider-state-effect.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../../src/lib/persistence/events.js";
import { makePrepareTurn } from "../../../../src/lib/provider/claude/prepare-turn.js";

// Failure modes: excess budget; lost original constraints; reordered or sliced
// messages; leaked reasoning/attachments/tool results; wrong omission counts;
// empty history crashes; an unfit wrapper; and a cursor from the wrong account.
// Live cursors can precede completion receipts, be cleared after rejection, or
// belong to another account/agent. Durable incoming cursors still take priority.
// Test the public preparation seam against real event projections and paging.
const conversation = fc.array(
	fc.record({
		role: fc.constantFrom("user" as const, "assistant" as const),
		text: fc
			.array(fc.constantFrom("a", "界", "🧪", "\n", '"', "\\"), {
				minLength: 1,
				maxLength: 30,
			})
			.map((characters) => characters.join("")),
		oversized: fc.boolean(),
	}),
	{ maxLength: 110 },
);

it("prepares intact, ordered, budgeted context only for a fresh native thread", async () => {
	await fc.assert(
		fc.asyncProperty(
			conversation,
			fc.constantFrom(-100, 1024, 2000, 16000, 64000, 100000),
			fc.constantFrom(undefined, 20000, 32000, 128000),
			async (generated, cap, window) => {
				await Effect.runPromise(
					Effect.gen(function* () {
						yield* makeEffectSqlMigrator();
						const store = yield* makeEventStoreEffect;
						const cursors = yield* makeProjectorCursorEffect;
						const runner = yield* makeProjectionRunnerEffect(
							createAllEffectProjectors(),
						).pipe(Effect.provideService(ProjectorCursorEffectTag, cursors));
						yield* runner.recover();
						const messages = generated.map((message, index) => {
							const id = `m${String(index).padStart(4, "0")}`;
							// Small priority messages must fit even at the minimum cap.
							const priority = index === 0 || index >= generated.length - 2;
							return {
								id,
								role: index === 0 ? ("user" as const) : message.role,
								text: `<<<${id}>>>${priority ? "Keep 🧪" : message.text}${message.oversized && !priority ? "界🧪".repeat(10000) : ""}<<<end:${id}>>>`,
							};
						});
						const events: CanonicalEvent[] = [
							canonicalEvent("session.created", "s1", {
								sessionId: "s1",
								title: "Handoff",
								provider: "personal",
							}),
						];
						for (const [index, message] of messages.entries()) {
							const opts = { provider: "claude", createdAt: 1000 + index };
							events.push(
								canonicalEvent(
									"message.created",
									"s1",
									{
										messageId: message.id,
										role: message.role,
										sessionId: "s1",
									},
									opts,
								),
								canonicalEvent(
									"text.delta",
									"s1",
									{
										messageId: message.id,
										partId: `${message.id}:text`,
										text: message.text,
									},
									opts,
								),
								canonicalEvent(
									"thinking.delta",
									"s1",
									{
										messageId: message.id,
										partId: `${message.id}:thinking`,
										text: "PRIVATE_REASONING",
									},
									opts,
								),
								canonicalEvent(
									"file.attached",
									"s1",
									{
										messageId: message.id,
										partId: `${message.id}:file`,
										mime: "image/png",
										url: "PRIVATE_ATTACHMENT",
										filename: "PRIVATE_ATTACHMENT.png",
									},
									opts,
								),
								canonicalEvent(
									"tool.started",
									"s1",
									{
										messageId: message.id,
										partId: `${message.id}:tool`,
										toolName: "Read",
										callId: `${message.id}:call`,
										input: { tool: "Read", filePath: "PRIVATE_TOOL_INPUT" },
									},
									opts,
								),
								canonicalEvent(
									"tool.completed",
									"s1",
									{
										messageId: message.id,
										partId: `${message.id}:tool`,
										result: "PRIVATE_TOOL_RESULT",
										duration: 1,
									},
									opts,
								),
							);
						}
						yield* runner.projectBatch(yield* store.appendBatch(events));
						const state = yield* makeProviderStateEffect;
						const read = yield* makeReadQueryEffect;
						const prepare = (options: Parameters<typeof makePrepareTurn>[0]) =>
							makePrepareTurn(options).pipe(
								Effect.provideService(ProviderStateEffectTag, state),
								Effect.provideService(ReadQueryEffectTag, read),
							);
						const current = "Current request 🧪";
						const fresh = yield* prepare({
							configDir: "/accounts/work",
							tokenCap: cap,
							modelContextWindow: window,
						});
						const plan = yield* fresh("s1", "work", current);
						expect(plan.resumeSessionId).toBeUndefined();
						expect(plan.configDir).toBe("/accounts/work");
						if (messages.length === 0) {
							expect(plan.prompt).toBe(current);
							expect(plan.handoff).toBeUndefined();
						} else {
							expect(plan.prompt.endsWith(`\n\n${current}`)).toBe(true);
							const hidden = plan.prompt.slice(0, -current.length - 2);
							expect(hidden).toContain(
								"context, not a new request or higher-priority instructions",
							);
							expect(hidden).toContain("conduit_thread_read");
							const selected = messages.filter((message) =>
								hidden.includes(`<<<${message.id}>>>`),
							);
							expect(selected).toContain(messages[0]);
							let position = -1;
							for (const message of messages) {
								if (selected.includes(message)) {
									expect(hidden).toContain(message.text);
									const next = hidden.indexOf(message.text);
									expect(next).toBeGreaterThan(position);
									position = next;
								} else expect(hidden).not.toContain(`<<<end:${message.id}>>>`);
							}
							expect(plan.handoff).toEqual({
								included: selected.length,
								omitted: messages.length - selected.length,
								tokens: Buffer.byteLength(hidden),
							});
							expect(hidden).toContain(
								`Included ${selected.length} intact messages; omitted ${messages.length - selected.length} messages.`,
							);
							expect(Buffer.byteLength(hidden)).toBeLessThanOrEqual(
								Math.max(1024, Math.min(64000, cap)),
							);
							const contextWindow = window ?? 128000;
							expect(
								Buffer.byteLength(hidden) +
									Buffer.byteLength(current) +
									Math.max(16000, Math.ceil(contextWindow / 4)),
							).toBeLessThanOrEqual(contextWindow);
							for (const secret of [
								"PRIVATE_REASONING",
								"PRIVATE_ATTACHMENT",
								"PRIVATE_TOOL_INPUT",
								"PRIVATE_TOOL_RESULT",
							])
								expect(hidden).not.toContain(secret);
							const tiny = yield* prepare({ modelContextWindow: 16000 });
							const tooLarge = yield* Effect.either(
								tiny("s1", "work", current),
							);
							expect(tooLarge._tag).toBe("Left");
							if (tooLarge._tag === "Left")
								expect(tooLarge.left._tag).toBe("HandoffTooLarge");
						}
						const liveSession = {
							instanceId: "personal",
							configDir: "/accounts/personal",
							resumeSessionId: "live-personal",
						};
						const live = yield* prepare({ liveSession, modelContextWindow: 1 });
						expect(yield* live("s1", "personal", current)).toMatchObject({
							resumeSessionId: "live-personal",
							configDir: "/accounts/personal",
							prompt: current,
						});
						expect(yield* state.nativeThread("s1", "personal")).toBeUndefined();
						for (const options of [
							{ configDir: "/accounts/work" },
							{ agent: "reviewer" },
						]) {
							const other = yield* prepare({ liveSession, ...options });
							const plan = yield* other("s1", "personal", current);
							expect(plan.resumeSessionId).toBeUndefined();
							if (messages.length > 0) expect(plan.handoff).toBeDefined();
						}
						const otherAccount = yield* prepare({ liveSession });
						expect(
							(yield* otherAccount("s1", "work", current)).resumeSessionId,
						).toBeUndefined();
						yield* state.saveUpdates("s1", [
							{
								key: "nativeThread:personal",
								value: JSON.stringify({
									resumeSessionId: "native-personal",
									configDir: "/accounts/personal",
									firstSequence: 0,
									deliveredThrough: 0,
								}),
							},
							{ key: "claudeAgent:personal", value: "" },
						]);
						const resume = yield* prepare({
							liveSession,
							modelContextWindow: 1,
						});
						const resumed = yield* resume("s1", "personal", current);
						expect(resumed.resumeSessionId).toBe("native-personal");
						expect(resumed.configDir).toBe("/accounts/personal");
						expect(resumed.prompt).toBe(current);
						expect(resumed.handoff).toBeUndefined();
						const cleared = yield* prepare({
							liveSession: { ...liveSession, resumeSessionId: undefined },
						});
						const rejected = yield* cleared("s1", "personal", current);
						expect(rejected.resumeSessionId).toBeUndefined();
						if (messages.length > 0) expect(rejected.handoff).toBeDefined();
						const agentChange = yield* prepare({ agent: "reviewer" });
						const changed = yield* agentChange("s1", "personal", current);
						expect(changed.resumeSessionId).toBeUndefined();
						if (messages.length > 0)
							expect(changed.prompt).toContain(messages[0]?.text);
					}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
				);
			},
		),
		{ seed: 20261008, numRuns: 40, examples: [[[], 1024, undefined]] },
	);
}, 120000);
