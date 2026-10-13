import { AccountIdSchema } from "../../../../src/lib/contracts/provider-instance.js";
import { AccountDirectory } from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	makeMockAccountDirectory,
	makeOpenCodeInstancesStub,
} from "../../../helpers/mock-factories.js";
// Failure modes: choosing only the current account; accepting a receipt before
// firstSequence or after deliveredThrough; losing an intermediate account after
// switching back; rejecting an uncovered point; copying history past the point;
// resuming a fresh child or handing it unbounded history instead of prepareTurn.

import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { forkSession } from "../../../../src/lib/domain/relay/Services/session-command.js";
import { makeOverridesStateLive } from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { sessionPickEvents } from "../../../../src/lib/domain/relay/Services/session-pick.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProviderStateEffectTag } from "../../../../src/lib/persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { makePrepareTurn } from "../../../../src/lib/provider/claude/prepare-turn.js";
import { claudeSdk } from "../../../helpers/fake-claude-process-sdk.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../../helpers/orchestration-engine-test-double.js";

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
				canonicalEvent("session.model_changed", "parent", {
					sessionId: "parent",
					providerId: "claude",
					modelId: "sonnet",
				}),
				canonicalEvent("session.variant_changed", "parent", {
					sessionId: "parent",
					variant: "high",
				}),
				canonicalEvent("session.context_window_changed", "parent", {
					sessionId: "parent",
					contextWindow: "200k",
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
						configDir: configuredClaudeConfigDir("/source"),
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
						configDir: configuredClaudeConfigDir("/target"),
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
			expect(childRow).toMatchObject({
				model_provider: "claude",
				model_id: "sonnet",
				variant: "high",
				context_window: "200k",
			});
			expect(childRow?.parent_id).toBe("parent");
			expect(childRow?.fork_point_message_id).toBe(boundary);
			const history = yield* read.getSessionMessagesWithParts(child.id);
			expect(history.at(-1)?.id).toBe(`${boundary}_${child.id}`);
			expect(history.some((row) => row.text.includes("Future history"))).toBe(
				false,
			);
			const expectedParentAccount =
				point === "returned" ? "claude" : "claude-sdk";
			expect((yield* read.getSession("parent"))?.provider).toBe(
				expectedParentAccount,
			);
			const expectedAccount = point === "before" ? "claude" : "claude-sdk";
			expect(childRow?.provider).toBe(expectedAccount);
			const prepare = yield* makePrepareTurn({
				folderSource: "account",
				configDir: configuredClaudeConfigDir(
					point === "before" ? "/source" : "/target",
				),
			});
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
				const nativeId = point === "before" ? "source-sdk" : "target-sdk";
				const nativeFolder = configuredClaudeConfigDir(
					point === "before" ? "/source" : "/target",
				);
				expect(readTranscript).toHaveBeenCalledWith(nativeId, {
					configDir: nativeFolder,
				});
				expect(forkNative).toHaveBeenCalledWith(nativeId, {
					configDir: nativeFolder,
					title: "Parent (fork)",
					upToMessageId: boundary,
				});
				expect(prepared.resumeSessionId).toBe("child-sdk");
				expect(prepared.prompt).toBe("Continue the child");
			}
		}).pipe(
			Effect.provideService(
				OrchestrationEngineTag,
				withDispatchEffect({
					dispatchEffect: vi.fn(() =>
						Effect.succeed({
							models: [
								{
									id: "sonnet",
									name: "Sonnet",
									providerId: "claude",
									variants: { high: {} },
									contextWindowOptions: [{ value: "200k", label: "200k" }],
								},
							],
							supportsTools: true,
							supportsThinking: true,
							supportsPermissions: true,
							supportsQuestions: true,
							supportsAttachments: true,
							supportsFork: true,
							supportsRevert: false,
							commands: [],
						}),
					),
				}),
			),
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
			Effect.provideService(
				AccountDirectory,
				makeMockAccountDirectory([
					{
						driver: "claude",
						id: AccountIdSchema.make("claude"),
						name: "Source",
						folder: configuredClaudeConfigDir("/source"),
						usageEligible: true,
					},
					{
						driver: "claude",
						id: AccountIdSchema.make("claude-sdk"),
						name: "Target",
						folder: configuredClaudeConfigDir("/target"),
						usageEligible: true,
					},
				]),
			),
			Effect.provideService(
				OpenCodeInstancesTag,
				makeOpenCodeInstancesStub({}),
			),
			Effect.provide(makeOverridesStateLive()),
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
		),
	);
});

// A fork must use the kept branch even while the native transcript still has
// its discarded tail. Exercise canonical events, SQLite projection, the fork
// command and the child's real turn planner without opening a relay socket.
it.each([
	"pending",
	"committed",
] as const)("forks only kept Claude history after a %s rewind", async (phase) => {
	const readTranscript = vi.fn(async (sdkId: string) =>
		[
			{ id: "first", role: "user" as const },
			{ id: "before", role: "assistant" as const },
			{ id: "uncovered", role: "user" as const },
			{ id: "later", role: "assistant" as const },
		].map(({ id, role }) => ({
			type: role,
			uuid: `${id}-native`,
			session_id: sdkId,
			message: { id, role, content: [{ type: "text", text: id }] },
			parent_tool_use_id: null,
			parent_agent_id: null,
		})),
	);
	const forkNative = vi.fn(async () => ({ sessionId: "rewind-child-sdk" }));
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const state = yield* ProviderStateEffectTag;
			const read = yield* ReadQueryEffectTag;
			yield* commit([
				canonicalEvent("session.created", "parent", {
					sessionId: "parent",
					title: "Parent",
					provider: "claude",
				}),
				...sessionPickEvents("parent", {
					harness: "claude",
					model: { providerId: "claude", modelId: "sonnet" },
					effort: "high",
					contextWindow: "200k",
				}),
				...message("first", "user", "Kept request"),
				...message("before", "assistant", "Kept response"),
				...message("uncovered", "user", "Discarded request"),
				...message("later", "assistant", "Discarded response"),
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
				canonicalEvent("session.rewound", "parent", {
					messageId: "uncovered",
				}),
			]);
			if (phase === "committed")
				yield* commit([
					canonicalEvent("message.removed", "parent", {
						messageId: "uncovered",
					}),
					canonicalEvent("message.removed", "parent", {
						messageId: "later",
					}),
					canonicalEvent("session.rewind_committed", "parent", {
						messageId: "uncovered",
					}),
				]);
			expect(
				(yield* read.getSessionMessagesWithParts("parent")).map(
					(row) => row.id,
				),
			).toEqual(["first", "before"]);
			const rejected = yield* Effect.either(
				forkSession("parent", { messageId: "uncovered" }),
			);
			expect(rejected._tag).toBe("Left");
			const child = yield* forkSession("parent");
			const history = yield* read.getSessionMessagesWithParts(child.id);
			expect
				.soft(history.map((row) => row.text))
				.toEqual(["Kept request", "Kept response"]);
			expect.soft(forkNative).not.toHaveBeenCalled();
			const prepare = yield* makePrepareTurn({
				folderSource: "account",
				configDir: configuredClaudeConfigDir("/source"),
			});
			const prepared = yield* prepare(child.id, "claude", "Continue child");
			expect.soft(prepared.resumeSessionId).toBeUndefined();
			expect.soft(prepared.prompt).toContain("Kept request");
			expect.soft(prepared.prompt).toContain("Kept response");
			expect.soft(prepared.prompt).not.toContain("Discarded");
		}).pipe(
			Effect.provideService(
				OrchestrationEngineTag,
				withDispatchEffect({
					dispatchEffect: vi.fn(() =>
						Effect.succeed({
							models: [
								{
									id: "sonnet",
									name: "Sonnet",
									providerId: "claude",
									variants: { high: {} },
									contextWindowOptions: [{ value: "200k", label: "200k" }],
								},
							],
						}),
					),
				}),
			),
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
			Effect.provideService(
				AccountDirectory,
				makeMockAccountDirectory([
					{
						driver: "claude",
						id: AccountIdSchema.make("claude"),
						name: "Source",
						folder: configuredClaudeConfigDir("/source"),
						usageEligible: true,
					},
					{
						driver: "claude",
						id: AccountIdSchema.make("claude-sdk"),
						name: "Target",
						folder: configuredClaudeConfigDir("/target"),
						usageEligible: true,
					},
				]),
			),
			Effect.provideService(
				OpenCodeInstancesTag,
				makeOpenCodeInstancesStub({}),
			),
			Effect.provide(makeOverridesStateLive()),
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
		),
	);
});
