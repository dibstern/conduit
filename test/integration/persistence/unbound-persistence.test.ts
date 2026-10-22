// Failure modes: a captured project stamps another project's events, creation
// silently chooses a project, a mixed batch partly commits, native receipts or
// child sessions inherit the wrong project, or direct writes announce one owner.
// Bound wrappers must reject conflicting provenance before opening a transaction,
// including empty writes, without poisoning a later unbound retry.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	ClaudeEventPersistEffectTag,
	makeClaudeEventPersistEffect,
	UnboundClaudeEventPersistEffectTag,
} from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import {
	makeCommitAndSignal,
	makeUnboundCommitAndSignal,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceDaemonLayer,
	makePersistenceProjectLayer,
	makePersistenceStoreLayer,
} from "../../../src/lib/persistence/effect/live.js";
import {
	makeProviderStateEffect,
	ProviderStateEffectTag,
	UnboundProviderStateEffectTag,
} from "../../../src/lib/persistence/effect/provider-state-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const evidence: { multiProject?: unknown; typedFailures?: unknown } = {};
const boundEvidence: unknown[] = [];

afterAll(() => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/82tn-10-2-unbound-persistence.json",
		JSON.stringify(
			{
				bead: "conduit-test-82tn.10.2",
				passed:
					evidence.multiProject !== undefined &&
					evidence.typedFailures !== undefined,
				...evidence,
			},
			null,
			2,
		),
	);
	writeFileSync(
		"test-results/82tn-10-2-bound-projects.json",
		JSON.stringify(
			{
				bead: "conduit-test-82tn.10.2",
				passed: boundEvidence.length === 26,
				cases: boundEvidence,
			},
			null,
			2,
		),
	);
});

describe.each([
	"project-layer",
	"legacy-factories",
] as const)("bound persistence via %s", (binding) => {
	it.each([
		"append",
		"appendBatch",
		"commit",
		"write",
		"saveUpdates",
		"clearState",
		"persistEvent",
		"persistEvents",
		"persistUserMessage",
		"ensureClaudeSubagentSession",
		"persistHandoffDelivered",
		"emptyAppendBatch",
		"emptyPersistEvents",
	] as const)("%s rejects a foreign project before writing and permits an unbound retry", async (operation) => {
		const runtime = ManagedRuntime.make(
			Layer.merge(
				makePersistenceProjectLayer("alpha"),
				makePersistenceDaemonLayer(),
			).pipe(Layer.provideMerge(makePersistenceStoreLayer(":memory:"))),
		);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const store = yield* binding === "project-layer"
						? EventStoreEffectTag
						: makeEventStoreEffect;
					const state = yield* binding === "project-layer"
						? ProviderStateEffectTag
						: makeProviderStateEffect;
					const claude = yield* binding === "project-layer"
						? ClaudeEventPersistEffectTag
						: makeClaudeEventPersistEffect.pipe(
								Effect.provideService(EventStoreEffectTag, store),
							);
					const write = yield* makeCommitAndSignal.pipe(
						Effect.provideService(EventStoreEffectTag, store),
					);
					const unboundStore = yield* UnboundEventStoreEffectTag;
					const unboundState = yield* UnboundProviderStateEffectTag;
					const unboundClaude = yield* UnboundClaudeEventPersistEffectTag;
					const unboundWrite = yield* makeUnboundCommitAndSignal;
					const created = (sessionId: string) =>
						canonicalEvent("session.created", sessionId, {
							sessionId,
							title: sessionId,
							provider: "claude",
						});
					const createsSession = [
						"append",
						"appendBatch",
						"commit",
						"write",
					].includes(operation);
					const empty =
						operation === "emptyAppendBatch" ||
						operation === "emptyPersistEvents";
					const owners = (sessionId: string) =>
						operation === "append" || operation === "appendBatch"
							? sql`SELECT DISTINCT project_id FROM events WHERE session_id = ${sessionId}`
							: sql`SELECT project_id FROM sessions WHERE id = ${sessionId}`;
					const seed = (sessionId: string, projectId: string) =>
						Effect.gen(function* () {
							yield* unboundWrite([created(sessionId)], { projectId });
							yield* sql`UPDATE sessions SET model_id = 'sonnet', model_provider = 'claude', variant = '', context_window = '' WHERE id = ${sessionId}`;
							yield* unboundState.saveUpdates(sessionId, [
								{ key: "cursor", value: "original" },
							]);
							if (operation === "persistHandoffDelivered")
								yield* sql`INSERT INTO provider_command_outbox (command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
									VALUES (${`${sessionId}-command`}, ${projectId}, ${sessionId}, 'claude', 'send_turn', '{}', 'completed', 1, 1, 1)`;
						});
					const verifyWritten = (sessionId: string, projectId: string) =>
						Effect.gen(function* () {
							if (empty) return;
							expect(yield* owners(sessionId)).toEqual([
								{ project_id: projectId },
							]);
							switch (operation) {
								case "saveUpdates":
									expect(
										yield* sql`SELECT value FROM provider_state WHERE session_id = ${sessionId} AND key = 'cursor'`,
									).toEqual([{ value: "new" }]);
									break;
								case "clearState":
									expect(
										yield* sql`SELECT key FROM provider_state WHERE session_id = ${sessionId}`,
									).toEqual([]);
									break;
								case "persistEvent":
								case "persistEvents":
									expect(
										yield* sql`SELECT title FROM sessions WHERE id = ${sessionId}`,
									).toEqual([{ title: "Updated" }]);
									break;
								case "persistUserMessage":
									expect(
										yield* sql`SELECT p.text FROM messages m JOIN message_parts p ON p.message_id = m.id WHERE m.session_id = ${sessionId} AND m.role = 'user'`,
									).toEqual([{ text: "Hello" }]);
									break;
								case "ensureClaudeSubagentSession":
									expect(
										yield* sql`SELECT project_id, parent_id, provider_sid FROM sessions WHERE id = ${`${sessionId}-child`}`,
									).toEqual([
										{
											project_id: projectId,
											parent_id: sessionId,
											provider_sid: `${sessionId}-native`,
										},
									]);
									break;
								case "persistHandoffDelivered":
									expect(
										yield* sql`SELECT project_id FROM events WHERE event_id = ${`evt_claude_handoff_delivered_${sessionId}-command`}`,
									).toEqual([{ project_id: projectId }]);
									break;
							}
						});
					const perform = (
						sessionId: string,
						projectId?: string,
						bound = true,
					) =>
						Effect.gen(function* () {
							const events = bound ? store : unboundStore;
							const provider = bound ? state : unboundState;
							const persist = bound ? claude : unboundClaude;
							const commit = bound ? write : unboundWrite;
							const options = projectId === undefined ? {} : { projectId };
							const event = canonicalEvent("session.renamed", sessionId, {
								sessionId,
								title: "Updated",
							});
							switch (operation) {
								case "append":
									yield* events.append(created(sessionId), projectId);
									break;
								case "appendBatch":
									yield* events.appendBatch([created(sessionId)], projectId);
									break;
								case "emptyAppendBatch":
									yield* events.appendBatch([], projectId);
									break;
								case "commit":
									yield* commit([created(sessionId)], options);
									break;
								case "write":
									yield* commit.write(
										(_project, stamp) =>
											stamp((version) =>
												sql<{
													id: string;
												}>`INSERT INTO sessions (id, project_id, provider, provider_sid, title, status, created_at, updated_at, version)
								VALUES (${sessionId}, ${projectId ?? "alpha"}, 'claude', ${sessionId}, 'Direct', 'idle', 1, 1, ${version}) RETURNING id`.pipe(
													Effect.map((rows) => rows.map((row) => row.id)),
												),
											),
										options,
									);
									break;
								case "saveUpdates":
									yield* provider.saveUpdates(
										sessionId,
										[{ key: "cursor", value: "new" }],
										projectId,
									);
									break;
								case "clearState":
									yield* provider.clearState(sessionId, projectId);
									break;
								case "persistEvent":
									yield* persist.persistEvent(event, options);
									break;
								case "persistEvents":
									yield* persist.persistEvents([event], options);
									break;
								case "emptyPersistEvents":
									yield* persist.persistEvents([], options);
									break;
								case "persistUserMessage":
									yield* persist.persistUserMessage(
										sessionId,
										"Hello",
										options,
									);
									break;
								case "ensureClaudeSubagentSession":
									yield* persist.ensureClaudeSubagentSession({
										childSessionId: `${sessionId}-child`,
										parentSessionId: sessionId,
										providerSessionId: `${sessionId}-native`,
										title: "Child",
										...options,
									});
									break;
								case "persistHandoffDelivered":
									yield* persist.persistHandoffDelivered(
										sessionId,
										{
											included: 1,
											omitted: 0,
											tokens: 10,
										},
										`${sessionId}-command`,
										projectId,
									);
									break;
							}
						});
					const rejectedId = `${operation}-rejected`;
					if (!createsSession && !empty) {
						yield* seed(rejectedId, "beta");
					}
					const before = yield* sql`SELECT total_changes() AS changes`;
					const transactions = vi.spyOn(sql, "withTransaction");
					const rejected = yield* Effect.result(perform(rejectedId, "beta"));
					const transactionCount = transactions.mock.calls.length;
					transactions.mockRestore();
					const after = yield* sql`SELECT total_changes() AS changes`;
					const mismatch = {
						_tag: "EventStoreError",
						operation: "boundProject",
						projectId: "beta",
						ownerProjectId: "alpha",
					};
					expect(rejected).toMatchObject({
						_tag: "Failure",
						failure:
							operation === "saveUpdates" || operation === "clearState"
								? { _tag: "ProviderStateEffectError", cause: mismatch }
								: operation.startsWith("persist") ||
										operation === "ensureClaudeSubagentSession" ||
										operation === "emptyPersistEvents"
									? { _tag: "ClaudeEventPersistEffectError", cause: mismatch }
									: mismatch,
					});
					expect(transactionCount).toBe(0);
					expect(after).toEqual(before);
					yield* perform(rejectedId, "beta", false);
					yield* verifyWritten(rejectedId, "beta");
					for (const projectId of ["alpha", undefined]) {
						const sessionId = `${operation}-${projectId ?? "default"}`;
						if (!createsSession && !empty) {
							yield* seed(sessionId, "alpha");
						}
						yield* perform(sessionId, projectId);
						yield* verifyWritten(sessionId, "alpha");
					}
					return {
						binding,
						operation,
						rejected,
						transactionCount,
						unchanged: after,
						unboundRetry: "beta",
						accepted: ["alpha", "default"],
					};
				}),
			);
			boundEvidence.push(result);
		} finally {
			await runtime.dispose();
		}
	});
});

describe("unbound daemon persistence", () => {
	it("routes writes, receipts, child sessions and advances by session ownership", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-unbound-persistence-"));
		const runtime = ManagedRuntime.make(
			Layer.merge(
				makePersistenceDaemonLayer({
					sessionEventBusLayer: SessionEventBusLive,
				}),
				SessionEventBusLive,
			).pipe(
				Layer.provideMerge(makePersistenceStoreLayer(join(root, "events.db"))),
			),
		);
		try {
			evidence.multiProject = await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const store = yield* UnboundEventStoreEffectTag;
						const claude = yield* UnboundClaudeEventPersistEffectTag;
						const state = yield* UnboundProviderStateEffectTag;
						const sql = yield* SqlClient.SqlClient;
						const write = yield* makeUnboundCommitAndSignal;
						for (const projectId of ["alpha", "beta"]) {
							yield* write(
								[
									canonicalEvent("session.created", projectId, {
										sessionId: projectId,
										title: projectId,
										provider: "claude",
									}),
								],
								{ projectId },
							);
							yield* sql`UPDATE sessions SET model_id = 'sonnet', model_provider = 'claude', variant = '', context_window = '' WHERE id = ${projectId}`;
						}
						const single = yield* store.append(
							canonicalEvent("session.renamed", "alpha", {
								sessionId: "alpha",
								title: "Alpha",
							}),
						);
						expect(single.projectId).toBe("alpha");
						const mixed = yield* store.appendBatch(
							["alpha", "beta"].map((sessionId) =>
								canonicalEvent("session.renamed", sessionId, {
									sessionId,
									title: sessionId,
								}),
							),
						);
						expect(mixed.map((event) => event.projectId)).toEqual([
							"alpha",
							"beta",
						]);
						yield* claude.persistEvents(
							["alpha", "beta"].map((sessionId) =>
								canonicalEvent("session.renamed", sessionId, {
									sessionId,
									title: `Updated ${sessionId}`,
								}),
							),
						);
						for (const projectId of ["alpha", "beta"]) {
							yield* claude.persistUserMessage(
								projectId,
								`Hello ${projectId}`,
								{ messageId: `${projectId}-message` },
							);
							yield* state.saveUpdates(projectId, [
								{
									key: "nativeThread:claude",
									value: JSON.stringify({
										resumeSessionId: `${projectId}-native`,
										firstSequence: 0,
										deliveredThrough: 0,
									}),
								},
							]);
							expect(
								(yield* state.nativeThread(projectId, "claude"))?.projectId,
							).toBe(projectId);
							if (projectId === "beta")
								yield* sql`INSERT INTO sessions (id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
									VALUES ('beta-child', 'claude', 'beta-child-native', 'Unstamped child', 'idle', 'beta', 1, 1)`;
							yield* claude.ensureClaudeSubagentSession({
								childSessionId: `${projectId}-child`,
								parentSessionId: projectId,
								providerSessionId: `${projectId}-child-native`,
								title: "Child",
							});
						}
						const advances =
							yield* (yield* SessionEventBusTag).subscribeAdvances();
						yield* write.write((_project, stamp) =>
							stamp((version) =>
								sql<{
									id: string;
								}>`UPDATE sessions SET title = 'Stamped', version = ${version} WHERE id IN ('alpha', 'beta') RETURNING id`.pipe(
									Effect.map((rows) => rows.map((row) => row.id)),
								),
							),
						);
						const [advance] = yield* advances.pipe(
							Stream.take(1),
							Stream.runCollect,
						);
						expect(advance && [...advance.projectIds].sort()).toEqual([
							"alpha",
							"beta",
						]);
						const sessions = yield* sql<{
							id: string;
							project_id: string;
						}>`SELECT id, project_id FROM sessions ORDER BY id`;
						expect(sessions).toEqual([
							{ id: "alpha", project_id: "alpha" },
							{ id: "alpha-child", project_id: "alpha" },
							{ id: "beta", project_id: "beta" },
							{ id: "beta-child", project_id: "beta" },
						]);
						const stamps = yield* sql<{
							session_id: string;
							project_id: string;
						}>`SELECT DISTINCT session_id, project_id FROM events ORDER BY session_id`;
						expect(stamps).toEqual(
							sessions.map((row) => ({
								session_id: row.id,
								project_id: row.project_id,
							})),
						);
						return {
							sessions,
							eventProjects: stamps,
							directWriteAdvance: advance,
						};
					}),
				),
			);
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails unknown ownership through the typed channel and rolls back a mixed batch", async () => {
		const runtime = ManagedRuntime.make(
			makePersistenceDaemonLayer().pipe(
				Layer.provideMerge(makePersistenceStoreLayer(":memory:")),
			),
		);
		try {
			evidence.typedFailures = await runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* UnboundEventStoreEffectTag;
					const write = yield* makeUnboundCommitAndSignal;
					const created = (sessionId: string) =>
						canonicalEvent("session.created", sessionId, {
							sessionId,
							title: sessionId,
							provider: "claude",
						});
					// result handles typed failures, but a missing Context service defect
					// or an accidental SQL default still fails this assertion.
					const missing = yield* Effect.result(
						store.append(created("unknown")),
					);
					expect(missing).toMatchObject({
						_tag: "Failure",
						failure: {
							_tag: "EventStoreError",
							operation: "appendOwnership",
							sessionId: "unknown",
						},
					});
					yield* write([created("alpha")], { projectId: "alpha" });
					const before = yield* store.readFromSequence(0);
					const mixed = yield* Effect.result(
						store.appendBatch([
							canonicalEvent("session.renamed", "alpha", {
								sessionId: "alpha",
								title: "Should roll back",
							}),
							created("unknown"),
						]),
					);
					expect(mixed).toMatchObject({
						_tag: "Failure",
						failure: { _tag: "EventStoreError", sessionId: "unknown" },
					});
					const foreign = yield* Effect.result(
						store.append(created("alpha"), "beta"),
					);
					expect(foreign).toMatchObject({
						_tag: "Failure",
						failure: {
							_tag: "EventStoreError",
							projectId: "beta",
							ownerProjectId: "alpha",
						},
					});
					expect(yield* store.readFromSequence(0)).toEqual(before);
					return {
						unknownSession: missing,
						mixedBatch: mixed,
						foreignOwner: foreign,
						unchangedEventCount: before.length,
					};
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});
});
