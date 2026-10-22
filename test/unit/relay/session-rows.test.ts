import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { listDaemonSessions } from "../../../src/lib/domain/daemon/Services/daemon-session-reader.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { makeSessionRows } from "../../../src/lib/domain/daemon/Services/session-rows.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { makeRelayStatusSnapshot } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { announceBackgroundWork } from "../../../src/lib/domain/relay/Services/session-attention.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { subscribeSessionFamily } from "../../../src/lib/domain/relay/Services/session-family-subscription.js";
import { makeSessionListOperations } from "../../../src/lib/domain/relay/Services/session-manager-list.js";
import { emptySessionManagerState } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { createSessionGitCache } from "../../../src/lib/git/session-git.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const sessionId = "same-session";

const rowFields = (row: SessionInfo | undefined) => {
	if (!row) throw new Error("Expected the seeded session row");
	return {
		attention: row.attention,
		backgroundWork: row.backgroundWork,
		compacting: row.compacting,
		retrying: row.retrying,
		workspaceHint: row.workspaceHint,
		status: row.status,
	};
};

const snapshotRow = (snapshot: Option.Option<Envelope<SessionInfo>>) => {
	if (Option.isNone(snapshot) || snapshot.value._tag !== "snapshot")
		throw new Error("Expected a subscription snapshot");
	return snapshot.value.rows.find((row) => row.id === sessionId);
};

describe("Session Rows read paths", () => {
	for (const scope of ["project", "projects"] as const) {
		it.effect(
			`keeps the companion count and ${scope} page consistent across a queued write`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const readQuery = yield* ReadQueryEffectTag;
					yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, settled_at, created_at, updated_at)
						VALUES ('settled', 'project', 'opencode', 'Settled', 'idle', 100, 1, 1)`;
					const project = { slug: "project", folders: ["/tmp"] as const };
					const rows = yield* makeSessionRows(
						scope === "project" ? project : { projects: () => [project] },
					);
					const counted = yield* Deferred.make<void>();
					const writing = yield* Deferred.make<void>();
					// Fork outside the listing so the writer cannot inherit its transaction.
					const writer = yield* Effect.forkChild(
						Effect.gen(function* () {
							yield* Deferred.await(counted);
							yield* Deferred.succeed(writing, undefined);
							yield* sql`UPDATE sessions SET settled_at = NULL WHERE id = 'settled'`;
						}),
					);
					const result = yield* rows.listWith(
						undefined,
						readQuery.countSettledSessions({ projectIds: ["project"] }).pipe(
							Effect.tap(() =>
								Effect.gen(function* () {
									yield* Deferred.succeed(counted, undefined);
									yield* Deferred.await(writing);
									yield* Effect.yieldNow;
								}),
							),
						),
					);
					expect(result.companion).toBe(1);
					expect(result.sessions).toMatchObject([
						{ id: "settled", projectSlug: "project", settledAt: 100 },
					]);
					yield* Fiber.join(writer);
					expect(
						yield* readQuery.countSettledSessions({ projectIds: ["project"] }),
					).toBe(0);
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							makePersistenceEffectLayer(":memory:", "project"),
							Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
							Layer.effect(SessionActivityTag, makeSessionActivity),
						),
					),
				),
		);
	}

	for (const provider of ["claude", "cursor", "opencode"]) {
		it.effect(
			`Stop availability follows durable membership and delivery on ${provider}`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					const rows = yield* makeSessionRows({
						slug: "project",
						folders: ["/tmp"],
					});
					yield* commit([
						canonicalEvent("session.created", sessionId, {
							sessionId,
							title: "After reply",
							provider,
						}),
						canonicalEvent(
							"run.requested",
							sessionId,
							{ runId: "reply", inputId: "a" },
							{ provider, metadata: { runId: "reply" } },
						),
						canonicalEvent(
							"message.created",
							sessionId,
							{ sessionId, messageId: "a", inputId: "a", role: "user" },
							{ provider, metadata: { runId: "reply" } },
						),
						canonicalEvent(
							"run.started",
							sessionId,
							{ inputId: "a", requestedRunId: "reply" },
							{ provider, metadata: { runId: "reply" } },
						),
						canonicalEvent(
							"turn.completed",
							sessionId,
							{ messageId: "assistant-a" },
							{ provider: "claude", metadata: { runId: "reply" } },
						),
						canonicalEvent("input.admitted", sessionId, {
							sessionId,
							inputId: "b",
							delivery: "steer",
							request: { text: "correction" },
						}),
						canonicalEvent("input.sent", sessionId, {
							sessionId,
							inputId: "b",
							steer: true,
						}),
						canonicalEvent(
							"run.requested",
							sessionId,
							{ runId: "steer", inputId: "b" },
							{ provider, metadata: { runId: "steer" } },
						),
					]);
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'b', 'project', ${sessionId}, ${provider}, 'send_turn', 'steer', '{}', 'running', 1, 1, 1)`;
					const visible = Effect.map(rows.list(), (items) =>
						items.find(({ id }) => id === sessionId),
					);
					expect(yield* visible).toMatchObject({
						status: "busy",
						canStop: provider !== "claude",
					});
					yield* sql`UPDATE provider_command_outbox SET error_code = 'delivery_indeterminate' WHERE command_id = 'b'`;
					expect(yield* visible).toMatchObject({
						status: "busy",
						canStop: true,
					});
					yield* sql`UPDATE provider_command_outbox SET error_code = NULL WHERE command_id = 'b'`;
					// Placement makes a pending reservation stoppable even before acceptance.
					yield* commit([
						canonicalEvent(
							"message.created",
							sessionId,
							{
								sessionId,
								messageId: "b",
								inputId: "b",
								role: "user",
							},
							{ provider, metadata: { runId: "steer" } },
						),
					]);
					expect(yield* visible).toMatchObject({
						status: "busy",
						canStop: true,
					});
					expect(
						yield* sql`SELECT status, started_at FROM provider_runs WHERE id = 'steer'`,
					).toEqual([{ status: "pending", started_at: null }]);
					yield* commit([
						canonicalEvent(
							"run.started",
							sessionId,
							{ inputId: "b", requestedRunId: "steer" },
							{ provider, metadata: { runId: "steer" } },
						),
					]);
					expect(yield* visible).toMatchObject({
						status: "busy",
						canStop: true,
					});
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							makePersistenceEffectLayer(":memory:", "project"),
							Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
							Layer.effect(SessionActivityTag, makeSessionActivity),
						),
					),
				),
		);
	}

	for (const [taskType, attention] of [
		["local_bash", "monitoring"],
		["workflow", "working"],
	] as const) {
		it.effect(
			`shares ${attention} activity and hint dismissals across all four readers`,
			() => {
				const configDir = mkdtempSync(join(tmpdir(), "conduit-session-rows-"));
				const projectDir = join(configDir, "project-folder");
				const slug = "project";
				const folders: [string] = [projectDir];
				mkdirSync(projectDir);
				return Effect.gen(function* () {
					yield* Effect.addFinalizer(() =>
						Effect.sync(() =>
							rmSync(configDir, { recursive: true, force: true }),
						),
					);
					const activity = yield* makeSessionActivity;
					const activityLayer = Layer.succeed(SessionActivityTag)(activity);
					const persistence = makePersistenceEffectLayer(
						join(configDir, "events.db"),
						slug,
						undefined,
						SessionEventBusLive,
					).pipe(Layer.provide(activityLayer));
					const store = Layer.effect(
						PersistenceStore,
						Effect.context<PersistenceStoreContext>(),
					).pipe(Layer.provideMerge(persistence));
					const layer = Layer.mergeAll(
						store,
						activityLayer,
						SessionEventBusLive,
						Layer.succeed(ConfigTag)(
							makeMockConfig({ configDir, projectDir, slug }),
						),
						Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
						makeProjectRegistryLive([{ slug, title: "Project", folders }]),
					);
					yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const readQuery = yield* ReadQueryEffectTag;
						const accounts = yield* AccountDirectory;
						const runner = yield* ProjectionRunnerEffectTag;
						yield* runner.recover();
						const commit = yield* makeCommitAndSignal;
						yield* commit([
							canonicalEvent("session.created", sessionId, {
								sessionId,
								title: "Shared row",
								provider: "claude",
							}),
							canonicalEvent("session.workspace_hint_changed", sessionId, {
								path: "/workspace/hint",
							}),
						]);
						activity.background.record({
							sessionId,
							kind: "snapshot",
							tasks: [
								{ id: "task", type: taskType, description: "Background work" },
							],
						});
						activity.compactions.observe([
							canonicalEvent("session.compaction", sessionId, {
								sessionId,
								state: "started",
								detail: "Compacting context",
							}),
						]);
						activity.retries.observe([
							canonicalEvent("session.status", sessionId, {
								sessionId,
								status: "retry",
								message: "Retrying request",
							}),
						]);
						yield* announceBackgroundWork(sessionId);
						const operations = makeSessionListOperations({
							api: makeMockOpenCodeAPI(),
							stateRef: yield* Ref.make(emptySessionManagerState()),
							readQuery,
							sql,
							accounts,
							statusPollerOption: Option.none(),
							activity,
							snapshot: makeRelayStatusSnapshot(),
							projectFolders: folders,
							projectSlug: slug,
						});
						const cache = createSessionGitCache(async () => undefined);
						const readAll = Effect.gen(function* () {
							const relay = yield* operations.serviceListSessions();
							const shell = yield* Stream.runHead(
								subscribeShell().pipe(
									Stream.filter((frame) => frame._tag !== "projects"),
								),
							);
							const family = yield* Stream.runHead(
								subscribeSessionFamily({ sessionId }),
							);
							const daemon = yield* listDaemonSessions({}, cache);
							expect(daemon.availability).toEqual([
								{ projectSlug: slug, available: true },
							]);
							return [
								relay.find((row) => row.id === sessionId),
								snapshotRow(shell),
								snapshotRow(family),
								daemon.sessions.find((row) => row.id === sessionId),
							];
						});
						const visible = yield* readAll;
						for (const row of visible)
							expect(rowFields(row)).toEqual({
								attention,
								backgroundWork: attention,
								compacting: "Compacting context",
								retrying: "Retrying request",
								workspaceHint: "/workspace/hint",
								status: "idle",
							});
						const [stored] = yield* sql<{ workspace_hint_sequence: number }>`
						SELECT workspace_hint_sequence FROM sessions WHERE id = ${sessionId}`;
						if (!stored) throw new Error("Expected the stored hint generation");
						activity.hintDismissals.set(
							sessionId,
							stored.workspace_hint_sequence,
						);
						for (const row of yield* readAll) {
							expect(rowFields(row)).toEqual({
								...rowFields(visible[0]),
								workspaceHint: undefined,
							});
						}
					}).pipe(Effect.provide(layer, { local: true }));
				});
			},
		);
	}
});
