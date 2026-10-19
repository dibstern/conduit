import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { AccountDirectory } from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AlertsLive } from "../../../../src/lib/domain/relay/Services/alerts.js";
import { PendingInteractionServiceLive } from "../../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	ProviderTurnServiceLive,
	ProviderTurnServiceTag,
} from "../../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	clearProcessingTimeout,
	makeOverridesStateLive,
} from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { sessionPickEvents } from "../../../../src/lib/domain/relay/Services/session-pick.js";
import { SessionTitleServiceTag } from "../../../../src/lib/domain/relay/Services/session-title-service.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { synthesizeSnapshotEvent } from "../../../../src/lib/provider/opencode/opencode-history-backfill.js";
import { OrchestrationEngine } from "../../../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../../src/lib/provider/orchestration-read-model.js";
import { ProviderRegistry } from "../../../../src/lib/provider/provider-registry.js";
import type { ProviderInstance } from "../../../../src/lib/provider/types.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockOpenCodeModelService,
	makeMockSessionManagerService,
	makeMockSessionTitleService,
	makeMockWebSocketHandler,
} from "../../../helpers/mock-factories.js";

const persistence = makePersistenceEffectLayer(":memory:", "test-project");
const services = Layer.mergeAll(
	Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
	persistence,
	makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
	Layer.succeed(OpenCodeAPITag)(makeMockOpenCodeAPI()),
	Layer.succeed(OpenCodeModelServiceTag)(
		makeMockOpenCodeModelService({
			providers: [
				{
					id: "opencode",
					name: "OpenCode",
					models: [{ id: "test-model", name: "Test model" }],
				},
			],
			defaults: {},
			connected: ["opencode"],
		}),
	),
	Layer.succeed(WebSocketHandlerTag)(makeMockWebSocketHandler()),
	Layer.succeed(LoggerTag)(makeMockLogger()),
	Layer.succeed(ConfigTag)(
		makeMockConfig({ configDir: "/tmp/conduit-rewind-commit-no-config" }),
	),
	Layer.succeed(SessionManagerServiceTag)(makeMockSessionManagerService()),
	Layer.succeed(SessionTitleServiceTag)(makeMockSessionTitleService()),
	PendingInteractionServiceLive,
	makeOverridesStateLive(),
	AlertsLive,
);

const backfill = (
	messageId: string,
	role: "user" | "assistant",
	createdAt: number,
	text: string,
) =>
	synthesizeSnapshotEvent("s1", {
		id: messageId,
		sessionID: "s1",
		role,
		time: { created: createdAt },
		parts: [{ id: `${messageId}-text`, type: "text", text }],
	});

// Late provider/backfill rows can arrive after preparation but before acceptance.
// They must receive tombstones with the original suffix and resist later import.
it.effect(
	"commits a late hidden backfill with the rewind and prevents resurrection",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			const read = yield* ReadQueryEffectTag;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			yield* commit([
				canonicalEvent("session.created", "s1", {
					sessionId: "s1",
					title: "Rewind commit race",
					provider: "opencode",
				}),
				...sessionPickEvents("s1", {
					harness: "opencode",
					model: { providerId: "opencode", modelId: "test-model" },
					effort: "",
					contextWindow: "",
				}),
				...[
					{ messageId: "kept-user", role: "user" as const, createdAt: 10 },
					{
						messageId: "kept-assistant",
						role: "assistant" as const,
						createdAt: 20,
					},
					{ messageId: "cut-user", role: "user" as const, createdAt: 30 },
					{
						messageId: "cut-assistant",
						role: "assistant" as const,
						createdAt: 40,
					},
				].map(({ messageId, role, createdAt }) =>
					canonicalEvent(
						"message.created",
						"s1",
						{ sessionId: "s1", messageId, role },
						{ createdAt },
					),
				),
				canonicalEvent("session.rewound", "s1", { messageId: "cut-user" }),
			]);
			const prepared = yield* Deferred.make<void>();
			const accept = yield* Deferred.make<void>();
			const called = yield* Deferred.make<void>();
			const sentPrompts: string[] = [];
			const provider: ProviderInstance = {
				providerId: "opencode",
				discoverEffect: () => Effect.die("This send supplies its model"),
				sendTurnEffect: (input) =>
					Effect.gen(function* () {
						sentPrompts.push(input.prompt);
						yield* Deferred.succeed(called, undefined);
						return {
							status: "completed" as const,
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						};
					}),
				interruptTurnEffect: () => Effect.void,
				resolvePermissionEffect: () => Effect.void,
				resolveQuestionEffect: () => Effect.void,
				endSessionEffect: () => Effect.void,
				shutdownEffect: () => Effect.void,
			};
			const engine = new OrchestrationEngine({
				registry: new ProviderRegistry([provider]),
				accountDirectory: makeMockAccountDirectory(),
				durableCommands: {
					sql,
					projectKey: "test-project",
					snapshot: yield* new CommandReadModelRepository(
						sql,
						"test-project",
					).bootstrap(),
					now: () => 1000,
					generateId: () => "dispatch-1",
					write: (operation, options) =>
						Effect.gen(function* () {
							yield* Deferred.succeed(prepared, undefined);
							yield* Deferred.await(accept);
							return yield* commit.write(operation, options);
						}),
				},
			});
			const context = yield* Layer.build(ProviderTurnServiceLive).pipe(
				Effect.provideService(OrchestrationEngineTag, engine),
			);
			const turns = Context.get(context, ProviderTurnServiceTag);
			const send = yield* turns
				.sendTurn({
					clientId: "c1",
					commandId: "new-prompt",
					sessionId: "s1",
					text: "Continue from the cut",
					model: { providerID: "opencode", modelID: "test-model" },
				})
				.pipe(Effect.forkScoped);
			yield* Deferred.await(prepared);
			expect(sentPrompts).toEqual([]);
			yield* ingestion.ingestBatch([
				backfill("late-hidden", "assistant", 50, "Discarded before acceptance"),
			]);
			expect(
				(yield* read.getSessionMessagesWithParts("s1")).map(({ id }) => id),
			).toEqual(["kept-user", "kept-assistant"]);
			yield* Deferred.succeed(accept, undefined);
			yield* Fiber.join(send);
			yield* Deferred.await(called);
			yield* clearProcessingTimeout("s1");
			expect(sentPrompts).toEqual(["Continue from the cut"]);
			expect(
				yield* sql<{
					message_id: string;
				}>`SELECT message_id FROM message_tombstones
				WHERE session_id = 's1' ORDER BY message_id`,
			).toEqual([
				{ message_id: "cut-assistant" },
				{ message_id: "cut-user" },
				{ message_id: "late-hidden" },
			]);
			expect(
				(yield* read.getSession("s1"))?.pending_rewind_message_id,
			).toBeNull();
			yield* ingestion.ingestBatch([
				backfill("cut-user", "user", 30, "Stale discarded user"),
				backfill("cut-assistant", "assistant", 40, "Stale discarded assistant"),
				backfill("late-hidden", "assistant", 50, "Changed stale backfill"),
			]);
			expect(
				(yield* read.getSessionMessagesWithParts("s1")).map(({ id }) => id),
			).toEqual(["kept-user", "kept-assistant"]);
		}).pipe(Effect.provide(services)),
);
