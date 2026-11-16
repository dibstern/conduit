import { describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	EventMetadataSchema,
	RunnerWriteOrigin,
} from "../../../src/lib/contracts/stored-event.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/project-services/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { createProjectEventSink } from "../../../src/lib/provider/project-event-sink.js";
import { makeRunnerAuthority } from "../../../src/lib/provider/runner/runner-authority.js";
import {
	currentRunnerOutput,
	makeRunnerReceiptStore,
} from "../../../src/lib/provider/runner/runner-receipts.js";

// A fork can retain a receipt while losing its authority context; output and
// subagent creation must defect before SQL commits, rather than become daemon writes.
describe("runner ingestion authorization", () => {
	it.effect(
		"runner attribution leaves persisted JSON and historical replay unchanged",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const store = yield* EventStoreEffectTag;
				const historical = canonicalEvent("session.created", "parent", {
					sessionId: "parent",
					provider: "claude",
					title: "Parent",
				});
				yield* commit([historical]);
				const before = yield* store.readAllBySession("parent");
				const historicalJson = JSON.stringify(before);
				const authority = yield* makeRunnerAuthority();
				const grant = (yield* authority.adopt(
					[{ runnerId: "runner", sessionId: "parent" }],
					"live",
				)).grants.get("runner");
				if (!grant) return yield* Effect.die("missing grant");
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const sink = createProjectEventSink({
					sessionId: "parent",
					ingestion,
					pendingInteractions: {
						beginPermissionRequest: () =>
							Effect.succeed({
								awaitResponse: Effect.succeed({ decision: "once" }),
							}),
						resolvePermissionRequest: () => Effect.succeed(true),
						beginQuestionRequest: () =>
							Effect.succeed({ awaitAnswers: Effect.succeed({}) }),
						resolveQuestionRequest: () => Effect.succeed(true),
					},
				});
				const receipts = yield* makeRunnerReceiptStore(sql);
				yield* receipts.attach("runner", "attachment", { sessionId: "parent" });
				const committed = yield* Deferred.make<void>();
				yield* authority.guarded(
					grant,
					{ kind: "output" },
					sink
						.requestPermission({
							requestId: "native-permission",
							toolName: "Bash",
							toolInput: { command: "pwd" },
							sessionId: "parent",
							turnId: "turn",
							providerItemId: "tool",
						})
						.pipe(
							Effect.provideService(currentRunnerOutput, {
								runnerId: "runner",
								sequence: 1,
								attachmentId: "attachment",
								committed,
								consumed: true,
							}),
						),
				);
				const rows = yield* sql<{ type: string; metadata: string }>`
				SELECT type, metadata FROM events WHERE type LIKE 'permission.%' ORDER BY sequence`;
				expect(rows.map((row) => row.type)).toEqual([
					"permission.asked",
					"permission.resolved",
				]);
				for (const row of rows) expect(row.metadata).toBe("{}");
				const replayed = yield* store.readAllBySession("parent");
				expect(JSON.stringify(replayed.slice(0, before.length))).toBe(
					historicalJson,
				);
				expect(
					replayed.slice(before.length).map((event) => event.metadata),
				).toEqual([{}, {}]);
			}).pipe(
				Effect.provide(
					ProviderRuntimeIngestionLive.pipe(
						Layer.provideMerge(
							makePersistenceEffectLayer(":memory:", "test-project"),
						),
					),
				),
			),
	);
	it.effect(
		"canonical metadata encoding excludes ephemeral runner attribution",
		() =>
			Effect.sync(() => {
				expect(
					Schema.encodeUnknownSync(EventMetadataSchema)({
						[RunnerWriteOrigin]: "runner",
					}),
				).toEqual({});
			}),
	);
	it.effect(
		"revocation after commit drops subsequent runner memory observations",
		() => {
			const observed: string[] = [];
			return Effect.gen(function* () {
				const authority = yield* makeRunnerAuthority();
				const grant = (yield* authority.adopt(
					[{ runnerId: "runner", sessionId: "parent" }],
					"live",
				)).grants.get("runner");
				if (!grant) return yield* Effect.die("missing adopted grant");
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* authority.guarded(
					grant,
					{ kind: "output" },
					ingestion.ingestBatch(
						[
							{
								...decodeProviderRuntimeEvent({
									eventId: "runner-output",
									type: "message.created",
									providerId: "claude",
									sessionId: "parent",
									providerRefs: {},
									rawSource: { kind: "claude.sdk.message" },
									createdAt: 1,
									data: { messageId: "message", role: "assistant" },
								}),
								[RunnerWriteOrigin]: "runner",
							},
						],
						{
							afterCommit: authority
								.revoke(grant, "superseded")
								.pipe(Effect.asVoid),
						},
					),
				);
				expect(observed).toEqual([]);
			}).pipe(
				Effect.provide(
					makeProviderRuntimeIngestionLive({
						surfacing: {
							observe: () =>
								Effect.sync(() => {
									observed.push("surfacing");
								}),
						},
						compactions: {
							observe: () => {
								observed.push("compactions");
								return [];
							},
						},
						retries: {
							observe: () => {
								observed.push("retries");
								return [];
							},
						},
					}).pipe(
						Layer.provideMerge(
							makePersistenceEffectLayer(":memory:", "test-project"),
						),
					),
				),
			);
		},
	);
	for (const write of ["persistEvent", "persistEvents"] as const) {
		it.effect(
			`rejects ${write} runner attribution after receipt context is lost`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					const persist = yield* ClaudeEventPersistEffectTag;
					yield* commit([
						canonicalEvent("session.created", "parent", {
							sessionId: "parent",
							provider: "claude",
							title: "Parent",
						}),
					]);
					const event = canonicalEvent(
						"message.created",
						"parent",
						{
							sessionId: "parent",
							messageId: "stale-message",
							role: "assistant",
						},
						{ metadata: { [RunnerWriteOrigin]: "runner" } },
					);
					const result = yield* Effect.exit(
						write === "persistEvent"
							? persist.persistEvent(event)
							: persist.persistEvents([event]),
					);
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result))
						expect(
							result.cause.reasons
								.filter(Cause.isDieReason)
								.map((reason) => reason.defect),
						).toEqual([
							expect.objectContaining({ _tag: "MissingWriteAuthorization" }),
						]);
					expect(yield* sql`SELECT id FROM messages`).toEqual([]);
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(":memory:", "test-project"),
					),
				),
		);
	}
	it.effect(
		"interaction events retain explicit runner attribution when detached from their receipt context",
		() =>
			Effect.gen(function* () {
				const events: ProviderRuntimeEvent[] = [];
				const sink = createProjectEventSink({
					sessionId: "parent",
					ingestion: {
						ingest: (event, onPrompt) =>
							Effect.gen(function* () {
								events.push(event);
								yield* onPrompt?.("permission") ?? Effect.void;
								return 1;
							}),
					},
					pendingInteractions: {
						beginPermissionRequest: () =>
							Effect.succeed({
								awaitResponse: Effect.succeed({ decision: "once" }),
							}),
						resolvePermissionRequest: () => Effect.succeed(true),
						beginQuestionRequest: () =>
							Effect.succeed({ awaitAnswers: Effect.succeed({}) }),
						resolveQuestionRequest: () => Effect.succeed(true),
					},
				});
				const committed = yield* Deferred.make<void>();
				yield* sink
					.requestPermission({
						requestId: "native-permission",
						toolName: "Bash",
						toolInput: { command: "pwd" },
						sessionId: "parent",
						turnId: "turn",
						providerItemId: "tool",
					})
					.pipe(
						Effect.provideService(currentRunnerOutput, {
							runnerId: "runner",
							sequence: 1,
							attachmentId: "attachment",
							committed,
							consumed: true,
						}),
					);
				expect(events).toHaveLength(2);
				for (const event of events)
					expect(event[RunnerWriteOrigin]).toBe("runner");
			}),
	);
	for (const attribution of ["origin", "source"] as const) {
		it.effect(
			`rejects grant-less runner ${attribution} attribution after receipt context is lost`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const result = yield* Effect.exit(
						ingestion.ingest({
							...decodeProviderRuntimeEvent({
								eventId: "runner-without-context",
								type: "message.created",
								providerId: "claude",
								sessionId: "parent",
								providerRefs: {},
								rawSource: {
									kind:
										attribution === "source"
											? "runner.output"
											: "claude.sdk.message",
								},
								createdAt: 1,
								data: { messageId: "stale-message", role: "assistant" },
							}),
							...(attribution === "origin"
								? { [RunnerWriteOrigin]: "runner" }
								: {}),
						}),
					);
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result)) {
						expect(
							result.cause.reasons
								.filter(Cause.isDieReason)
								.map((reason) => reason.defect),
						).toEqual([
							expect.objectContaining({ _tag: "MissingWriteAuthorization" }),
						]);
					}
					expect(yield* sql`SELECT id FROM messages`).toEqual([]);
				}).pipe(
					Effect.provide(
						ProviderRuntimeIngestionLive.pipe(
							Layer.provideMerge(
								makePersistenceEffectLayer(":memory:", "test-project"),
							),
						),
					),
				),
		);
	}
	for (const write of ["event", "subagent"] as const) {
		it.effect(`rejects a grant-less ${write} carrying a receipt`, () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const persist = yield* ClaudeEventPersistEffectTag;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* commit([
					canonicalEvent("session.created", "parent", {
						sessionId: "parent",
						provider: "claude",
						title: "Parent",
					}),
				]);
				yield* sql`UPDATE sessions SET model_id = 'sonnet', model_provider = 'claude', variant = '', context_window = '' WHERE id = 'parent'`;
				const receipts = yield* makeRunnerReceiptStore(sql);
				yield* receipts.attach("runner", "attachment", { sessionId: "parent" });
				const committed = yield* Deferred.make<void>();
				const action: Effect.Effect<void, unknown> =
					write === "event"
						? ingestion
								.ingest(
									decodeProviderRuntimeEvent({
										eventId: "runner-output",
										type: "message.created",
										providerId: "claude",
										sessionId: "parent",
										providerRefs: {},
										rawSource: { kind: "claude.sdk.message" },
										createdAt: 1,
										data: { messageId: "stale-message", role: "assistant" },
									}),
								)
								.pipe(Effect.asVoid)
						: persist.ensureClaudeSubagentSession({
								childSessionId: "stale-child",
								parentSessionId: "parent",
								providerSessionId: "native-child",
								title: "Stale child",
							});
				const result = yield* Effect.exit(
					action.pipe(
						Effect.provideService(currentRunnerOutput, {
							runnerId: "runner",
							sequence: 1,
							attachmentId: "attachment",
							committed,
							consumed: false,
						}),
					),
				);
				expect(Exit.isFailure(result)).toBe(true);
				if (Exit.isFailure(result)) {
					expect(
						result.cause.reasons
							.filter(Cause.isDieReason)
							.map((reason) => reason.defect),
					).toEqual([
						expect.objectContaining({ _tag: "MissingWriteAuthorization" }),
					]);
				}
				expect(yield* sql`SELECT id FROM messages`).toEqual([]);
				expect(
					yield* sql`SELECT id FROM sessions WHERE id = 'stale-child'`,
				).toEqual([]);
			}).pipe(
				Effect.provide(
					ProviderRuntimeIngestionLive.pipe(
						Layer.provideMerge(
							makePersistenceEffectLayer(":memory:", "test-project"),
						),
					),
				),
			),
		);
	}
});
