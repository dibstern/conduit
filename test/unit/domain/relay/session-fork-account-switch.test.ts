// Failure modes: choosing only the current account; accepting a receipt before
// firstSequence or after deliveredThrough; losing an intermediate account after
// switching back; rejecting an uncovered point; copying history past the point;
// resuming a fresh child or handing it unbounded history instead of prepareTurn.
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import {
	ConfigTag,
	LoggerTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { forkSession } from "../../../../src/lib/domain/relay/Services/session-command.js";
import { makeOverridesStateLive } from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProviderStateEffectTag } from "../../../../src/lib/persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { makePrepareTurn } from "../../../../src/lib/provider/claude/prepare-turn.js";
import { claudeSdk } from "../../../helpers/fake-claude-process-sdk.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../../helpers/mock-factories.js";

const message = (id: string, role: "user" | "assistant", text: string) => [
	canonicalEvent(
		"message.created",
		"parent",
		{
			sessionId: "parent",
			messageId: id,
			role,
		},
		{
			createdAt:
				["first", "before", "oversized", "uncovered", "after", "later"].indexOf(
					id,
				) + 1,
		},
	),
	canonicalEvent("text.delta", "parent", {
		messageId: id,
		partId: `${id}:text`,
		text,
	}),
];

it.each([
	"before",
	"after",
	"uncovered",
	"returned",
] as const)("forks a switched session at %s through the canonical fork and turn preparation seams", async (point) => {
	const readTranscript = vi.fn(async (sdkId: string) => {
		const id = sdkId === "source-sdk" ? "before" : "after";
		return [
			{
				type: "assistant" as const,
				uuid: id,
				session_id: sdkId,
				message: {
					id,
					role: "assistant",
					content: [{ type: "text", text: id }],
				},
				parent_tool_use_id: null,
				parent_agent_id: null,
			},
		];
	});
	const forkNative = vi.fn(async () => ({ sessionId: "child-sdk" }));
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const state = yield* ProviderStateEffectTag;
			const read = yield* ReadQueryEffectTag;
			const events = yield* EventStoreEffectTag;
			yield* commit([
				canonicalEvent("session.created", "parent", {
					sessionId: "parent",
					title: "Parent",
					provider: "claude",
				}),
				...message("first", "user", "Original constraints"),
				...message("before", "assistant", "Before switching"),
				...message("oversized", "assistant", `OVERSIZED-${"x".repeat(20_000)}`),
			]);
			yield* state.saveUpdates("parent", [
				{
					key: "nativeThread:claude",
					value: JSON.stringify({
						resumeSessionId: "source-sdk",
						configDir: "/source",
						firstSequence: 0,
						deliveredThrough: 0,
					}),
				},
			]);
			yield* commit([
				...message("uncovered", "user", "An undelivered request"),
				canonicalEvent("session.provider_changed", "parent", {
					sessionId: "parent",
					oldProvider: "claude",
					newProvider: "claude-sdk",
				}),
				...message("after", "assistant", "After switching"),
			]);
			yield* state.saveUpdates("parent", [
				{
					key: "nativeThread:claude-sdk",
					value: JSON.stringify({
						resumeSessionId: "target-sdk",
						configDir: "/target",
						firstSequence: 0,
						deliveredThrough: 0,
					}),
				},
			]);
			const parentEvents = yield* events.readAllBySession("parent");
			const switchSequence = parentEvents.find(
				(event) => event.type === "session.provider_changed",
			)?.sequence;
			expect(
				(yield* state.nativeThread("parent", "claude-sdk"))?.firstSequence,
			).toBe(switchSequence);
			yield* commit(
				message("later", "assistant", "Future history must stay out"),
			);
			if (point === "returned")
				yield* commit([
					canonicalEvent("session.provider_changed", "parent", {
						sessionId: "parent",
						oldProvider: "claude-sdk",
						newProvider: "claude",
					}),
				]);
			const boundary = point === "returned" ? "after" : point;
			const child = yield* forkSession("parent", { messageId: boundary });
			const childRow = yield* read.getSession(child.id);
			expect(childRow?.parent_id).toBe("parent");
			expect(childRow?.fork_point_message_id).toBe(boundary);
			const history = yield* read.getSessionMessagesWithParts(child.id);
			expect(history.at(-1)?.id).toBe(`${boundary}_${child.id}`);
			expect(history.some((row) => row.text.includes("Future history"))).toBe(
				false,
			);
			const expectedAccount = point === "before" ? "claude" : "claude-sdk";
			expect(childRow?.provider).toBe(expectedAccount);
			const prepare = yield* makePrepareTurn();
			const prepared = yield* prepare(
				child.id,
				expectedAccount,
				"Continue the child",
			);
			if (point === "uncovered") {
				expect(forkNative).not.toHaveBeenCalled();
				expect(readTranscript).not.toHaveBeenCalled();
				expect(
					yield* state.nativeThread(child.id, expectedAccount),
				).toBeUndefined();
				expect(prepared.resumeSessionId).toBeUndefined();
				expect(prepared.handoff).toMatchObject({
					firstMessageIncluded: true,
					omitted: 1,
				});
				expect(prepared.handoff?.tokens).toBeLessThanOrEqual(16_000);
				expect(prepared.prompt).toContain("Original constraints");
				expect(prepared.prompt).toContain("An undelivered request");
				expect(prepared.prompt).not.toContain("OVERSIZED-");
				expect(prepared.prompt).not.toContain("After switching");
			} else {
				expect(readTranscript).toHaveBeenCalledWith(
					point === "before" ? "source-sdk" : "target-sdk",
					{
						dir: "/project",
						configDir: point === "before" ? "/source" : "/target",
					},
				);
				expect(forkNative).toHaveBeenCalledWith(
					point === "before" ? "source-sdk" : "target-sdk",
					{
						dir: "/project",
						configDir: point === "before" ? "/source" : "/target",
						title: "Parent (fork)",
						upToMessageId: boundary,
					},
				);
				expect(prepared.resumeSessionId).toBe("child-sdk");
				expect(prepared.prompt).toBe("Continue the child");
			}
		}).pipe(
			Effect.provideService(
				ConfigTag,
				makeMockConfig({
					projectDir: "/project",
					configDir: "/unused-config",
					claudeSdk: {
						...claudeSdk,
						fork: { readTranscript, forkSession: forkNative },
					},
				}),
			),
			Effect.provideService(LoggerTag, makeMockLogger()),
			Effect.provide(makeOverridesStateLive()),
			Effect.provide(makePersistenceEffectLayer(":memory:")),
		),
	);
});
