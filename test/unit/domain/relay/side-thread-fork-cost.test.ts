// Failure modes: copied history events; per-row INSERT statements; losing tool
// progress metadata or output references; inherited human messages triggering
// attention; a set-based copy producing a different transcript.
import { Effect } from "effect";
import { SqlClient, Statement } from "effect/sql";
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
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProviderStateEffectTag } from "../../../../src/lib/persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { CLAUDE_FORK_SOURCE_KEY } from "../../../../src/lib/provider/claude/claude-session-fork.js";
import { claudeSdk } from "../../../helpers/fake-claude-process-sdk.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../../helpers/orchestration-engine-test-double.js";

const TURNS = 4;
const TOOLS = 40;
let clock = 0;
const at = () => ({ createdAt: ++clock });

const turn = (n: number): CanonicalEvent[] => {
	const user = `user-${n}`;
	const reply = `reply-${n}`;
	return [
		canonicalEvent(
			"message.created",
			"parent",
			{ sessionId: "parent", messageId: user, role: "user" },
			at(),
		),
		canonicalEvent(
			"text.delta",
			"parent",
			{ messageId: user, partId: `${user}:text`, text: `Ask ${n}` },
			at(),
		),
		canonicalEvent(
			"message.created",
			"parent",
			{ sessionId: "parent", messageId: reply, role: "assistant" },
			at(),
		),
		...Array.from({ length: TOOLS }, (_, t) => {
			const partId = `${reply}:tool-${t}`;
			const heartbeat = () =>
				canonicalEvent(
					"tool.running",
					"parent",
					{ messageId: reply, partId },
					at(),
				);
			return [
				canonicalEvent(
					"tool.started",
					"parent",
					{
						messageId: reply,
						partId,
						toolName: "Bash",
						callId: partId,
						input: { tool: "Bash", command: `echo ${t}` },
					},
					at(),
				),
				heartbeat(),
				// Progress the transcript shows: never superseded by the copy.
				...(t % 10 === 0
					? [
							canonicalEvent(
								"tool.running",
								"parent",
								{ messageId: reply, partId, metadata: { progress: t } },
								at(),
							),
						]
					: []),
				heartbeat(),
				heartbeat(),
				// The last tool of the first turn never completes: its final
				// heartbeat is the only thing saying it ran.
				...(n === 0 && t === TOOLS - 1
					? []
					: [
							canonicalEvent(
								"tool.completed",
								"parent",
								{ messageId: reply, partId, result: `out ${t}`, duration: t },
								at(),
							),
						]),
			];
		}).flat(),
		canonicalEvent(
			"text.delta",
			"parent",
			{ messageId: reply, partId: `${reply}:text`, text: `Done ${n}` },
			at(),
		),
		canonicalEvent("turn.completed", "parent", { messageId: reply }, at()),
	];
};

// Compare content independently of the copy's identity, counters and provenance.
const transcript = (rows: readonly unknown[], sessionId: string) =>
	JSON.parse(
		JSON.stringify(rows)
			.replaceAll(`_${sessionId}`, "")
			.replaceAll(sessionId, "parent"),
		(key, value) =>
			key === "version" ||
			key === "last_applied_seq" ||
			key === "is_inherited" ||
			key === "is_human_sent"
				? undefined
				: value,
	);

it("copies a long Side Thread history in bounded statements with the same transcript", async () => {
	const sdk = {
		...claudeSdk,
		query: vi.fn(claudeSdk.query),
		fork: claudeSdk.fork && {
			...claudeSdk.fork,
			readTranscript: vi.fn(claudeSdk.fork.readTranscript),
			forkSession: vi.fn(claudeSdk.fork.forkSession),
		},
	};
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const read = yield* ReadQueryEffectTag;
			const store = yield* EventStoreEffectTag;
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
				...Array.from({ length: TURNS }, (_, n) => turn(n)).flat(),
			]);
			const state = yield* ProviderStateEffectTag;
			yield* state.saveUpdates("parent", [
				{ key: "resumeSessionId", value: "sdk-parent" },
			]);

			const shapes = new Map<string, number>();
			const child = yield* forkSession("parent", {
				side: { title: "Side", inputId: "side-input" },
			}).pipe(
				Effect.provideService(Statement.CurrentTransformer, (statement) => {
					const query = statement.compile()[0].replace(/\s+/g, " ").trim();
					const insert = query.match(
						/\bINSERT INTO (turns|messages|message_parts) /,
					);
					const shape = insert?.[0] ?? query.slice(0, 40);
					shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
					return Effect.succeed(statement);
				}),
			);
			const count = (prefix: string) =>
				[...shapes]
					.filter(([shape]) => shape.startsWith(prefix))
					.reduce((sum, [, n]) => sum + n, 0);

			const copied = yield* store.readAllBySession(child.id);
			expect(sdk.query).not.toHaveBeenCalled();
			expect(sdk.fork?.forkSession).not.toHaveBeenCalled();
			expect(sdk.fork?.readTranscript).not.toHaveBeenCalled();
			expect(yield* state.nativeThread(child.id, "claude")).toBeUndefined();
			expect(
				JSON.parse(
					(yield* state.getState(child.id))[CLAUDE_FORK_SOURCE_KEY] ?? "null",
				),
			).toEqual({
				instanceId: "claude",
				resumeSessionId: "sdk-parent",
				configDir: configuredClaudeConfigDir("/unused-config"),
				messageId: `reply-${TURNS - 1}`,
			});
			const sql = yield* SqlClient.SqlClient;
			for (const [sessionId, inherited, userHumanSent] of [
				["parent", 0, 1],
				[child.id, 1, 0],
			] as const) {
				expect(
					yield* sql`SELECT role, is_inherited, is_human_sent, COUNT(*) AS count
					FROM messages WHERE session_id = ${sessionId}
					GROUP BY role, is_inherited, is_human_sent ORDER BY role`,
				).toEqual([
					{
						role: "assistant",
						is_inherited: inherited,
						is_human_sent: 0,
						count: TURNS,
					},
					{
						role: "user",
						is_inherited: inherited,
						is_human_sent: userHumanSent,
						count: TURNS,
					},
				]);
			}
			expect(copied.some((event) => event.metadata.inherited === true)).toBe(
				false,
			);
			expect(
				copied.some(
					(event) =>
						event.type === "message.created" || event.type === "tool.running",
				),
			).toBe(false);
			for (const table of ["turns", "messages", "message_parts"]) {
				expect(count(`INSERT INTO ${table} `)).toBe(1);
			}
			expect(count("INSERT INTO events")).toBeLessThanOrEqual(4);
			expect
				.soft(
					transcript(
						yield* read.getSessionMessagesWithParts(child.id),
						child.id,
					),
				)
				.toEqual(
					transcript(
						yield* read.getSessionMessagesWithParts("parent"),
						child.id,
					),
				);
		}).pipe(
			Effect.provide(SessionWorkspaceLive),
			Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
			Effect.provideService(
				OrchestrationEngineTag,
				withDispatchEffect({
					dispatchEffect: () =>
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
				}),
			),
			Effect.provideService(
				ConfigTag,
				makeMockConfig({
					projectDir: "/project",
					configDir: "/unused-config",
					claudeSdk: sdk,
				}),
			),
			Effect.provideService(LoggerTag, makeMockLogger()),
			Effect.provideService(
				AccountDirectory,
				makeMockAccountDirectory([
					{
						driver: "claude",
						id: AccountIdSchema.make("claude"),
						name: "Claude",
						folder: configuredClaudeConfigDir("/unused-config"),
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
