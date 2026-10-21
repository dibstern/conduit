// Failure modes: a fork drops the parent's marks; inherits marks on parts past
// its cutoff; leaves them on parent part ids; or moves them off the parent.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/provider-instance.js";
import { AccountDirectory } from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { forkSession } from "../../../../src/lib/domain/relay/Services/session-command.js";
import { makeOverridesStateLive } from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { sessionPickEvents } from "../../../../src/lib/domain/relay/Services/session-pick.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../../src/lib/persistence/session-history-adapter.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { claudeSdk } from "../../../helpers/fake-claude-process-sdk.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../../helpers/orchestration-engine-test-double.js";

const ids = ["first", "before", "uncovered", "later"];
const message = (id: string, role: "user" | "assistant") => [
	canonicalEvent(
		"message.created",
		"parent",
		{ sessionId: "parent", messageId: id, role },
		{ createdAt: ids.indexOf(id) + 1 },
	),
	canonicalEvent("text.delta", "parent", {
		messageId: id,
		partId: `${id}:text`,
		text: id,
	}),
];

it("carries marks onto the fork's copies of the parts it kept", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const sql = yield* SqlClient.SqlClient;
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
				...message("first", "user"),
				...message("before", "assistant"),
				...message("uncovered", "user"),
				...message("later", "assistant"),
			]);
			// Seeded directly: the seam under test is the fork, not the writer.
			for (const id of ["before", "later"])
				yield* sql`INSERT INTO surfacing_marks (part_id, session_id, message_id, level, category, reason, direction, created_at)
					VALUES (${`${id}:text`}, 'parent', ${id}, 'balanced', NULL, ${`why ${id}`}, 'raise', 7)`;
			const marks = (sessionId: string) =>
				sql`SELECT part_id, message_id, level, category, reason, direction, created_at
					FROM surfacing_marks WHERE session_id = ${sessionId} ORDER BY part_id`;
			const parentMarks = yield* marks("parent");

			const child = yield* forkSession("parent", { messageId: "before" });

			expect(yield* marks(child.id)).toEqual([
				{
					part_id: `before:text_${child.id}`,
					message_id: `before_${child.id}`,
					level: "balanced",
					category: null,
					reason: "why before",
					direction: "raise",
					created_at: 7,
				},
			]);
			expect(yield* marks("parent")).toEqual(parentMarks);
			const history = messageRowsToHistory(
				yield* read.getSessionMessagesWithParts(child.id),
				{ pageSize: 10 },
			).messages.flatMap(({ parts }) => parts ?? []);
			expect(
				history.map(({ id, surfacingMark }) => [id, surfacingMark]),
			).toEqual([
				[`first:text_${child.id}`, undefined],
				[
					`before:text_${child.id}`,
					{ level: "balanced", reason: "why before", direction: "raise" },
				],
			]);
		}).pipe(
			Effect.provide(SessionWorkspaceLive),
			Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
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
						fork: {
							readTranscript: vi.fn(async () => []),
							forkSession: vi.fn(async () => ({ sessionId: "child-sdk" })),
						},
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
